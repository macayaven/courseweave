import { expect, test, type Page } from 'playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeOpenAiProvider } from './fake-openai-provider';
import { OwnedProcessTracker, stopOwnedProcess } from './process-cleanup';
import { inspectInstalledNotebookKernel } from './installed-kernel';
import { launchInstalledWorkspace } from './installed-wheel-helpers';
import { scanFiles } from './credential-scan';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const python=process.env.COURSEWEAVE_AUTHOR_PREVIEW_PYTHON;
const catalog=process.env.COURSEWEAVE_AUTHOR_PREVIEW_INPUTS;
const work=process.env.COURSEWEAVE_AUTHOR_PREVIEW_WORKROOT;
const version=process.env.COURSEWEAVE_PREVIEW_STUDENT_VERSION ?? '0.3.0';
const shareProvider=process.env.COURSEWEAVE_PREVIEW_SHARE_PROVIDER !== '0';
const fixture=join(repo,'tests/fixtures/author-preview-course');
const helper=join(repo,'frontend/e2e/author-preview-setup.py');

async function navigate(page:Page,url:string) {
  try { await page.goto(url,{waitUntil:'domcontentloaded'}); }
  catch { throw new Error('Owned Jupyter bootstrap could not open.'); }
  await expect.poll(()=>page.url().includes('token=')).toBe(false);
  await page.getByRole('button',{name:'Hide notification',exact:true}).click({timeout:1000}).catch(()=>undefined);
}

test('installed Author snapshot becomes isolated Student practice', async ({page,context})=>{
  test.skip(!python||!catalog||!work,'Requires explicitly installed Author and verified Student inputs on local storage.');
  const root=join(work!,`student-${version.replaceAll('.','')}`);
  await mkdir(root,{recursive:true});await mkdir(join(root,'bootstrap'),{mode:0o700});
  const environment=Object.fromEntries(['HOME','PATH','LANG','LC_ALL','TMPDIR','UV_CACHE_DIR'].flatMap(key=>process.env[key]?[[key,process.env[key]!]]:[]));
  const seed=spawnSync(python!,['-I',helper,'seed',fixture,root,catalog!],{cwd:root,env:environment,encoding:'utf8',timeout:60_000});
  if(seed.status!==0)throw new Error('Installed fixture preparation failed: '+seed.stderr.slice(-1500));
  const original=JSON.parse(await readFile(join(root,'seed.json'),'utf8'));
  const provider=await startFakeOpenAiProvider();
  const plantedModel='synthetic-preview-model-key',plantedSearch='synthetic-preview-search-key';
  const launch=()=>spawn(python!,['-I',helper,'launch',fixture,root,catalog!],{cwd:root,detached:true,stdio:['ignore','ignore','ignore'],env:{...environment,
    COURSEWEAVE_PROVIDER:'openai',OPENAI_MODEL:'stub-model',OPENAI_API_KEY:plantedModel,OPENAI_BASE_URL:provider.baseUrl,
    COURSEWEAVE_PROVIDER_PROFILE:'text-only-v1',BRAVE_SEARCH_API_KEY:plantedSearch}});
  let author=launch(),tracker=new OwnedProcessTracker(author.pid!);
  const trackers=[tracker];
  const result:any={category:'installed UI with explicitly synthetic local provider; automated actions and separate visual inspection',student_version:version,status:'running',checks:[]};
  let student:Page|undefined,previewId:string|undefined;
  const authorFrame=page.frameLocator('iframe[title="CourseWeave author"]');
  const panel=authorFrame.getByRole('region',{name:'Student practice preview',exact:true});
  const tokens:string[]=[];
  try {
    await page.setViewportSize({width:1280,height:960});
    await expect.poll(async()=> {
      if(author.exitCode!==null||author.signalCode!==null)throw new Error('Owned Author CLI exited before bootstrap: '+(author.exitCode??author.signalCode));
      return (await readdir(join(root,'bootstrap'))).length;
    },{timeout:60_000}).toBe(1);
    let url=await readFile(join(root,'bootstrap/open-0000'),'utf8');tokens.push(new URL(url).searchParams.get('token')!);
    await navigate(page,url);url='';
    await authorFrame.getByRole('combobox',{name:'Open project',exact:true}).selectOption('preview-practice');
    await panel.getByRole('button',{name:'Reload preview inputs',exact:true}).click();
    result.stage='Select preview inputs';
    await panel.getByRole('combobox',{name:'Preview Student version',exact:true}).selectOption(version);
    await expect(panel.getByLabel('Use Author’s configured model in this preview')).not.toBeChecked();
    if(shareProvider)await panel.getByLabel('Use Author’s configured model in this preview').check();
    result.stage='Prepare installed Student';
    const start=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/api/author/previews'));
    await panel.getByRole('button',{name:'Prepare Student preview',exact:true}).click();
    const started=await (await start).json();previewId=started.preview_id;result.preview=started;
    expect(started.provider_mode).toBe(shareProvider?'configured':'off');
    expect(started.package_sha256).toBe(original.package_sha256);
    await expect(panel.getByRole('button',{name:'Open Student preview',exact:true})).toBeVisible({timeout:180_000});
    await expect.poll(()=>provider.requests.length).toBe(0);
    result.stage='Open actual Student';
    await panel.getByRole('button',{name:'Open Student preview',exact:true}).focus();await page.keyboard.press('Enter');
    await expect.poll(async()=>(await readdir(join(root,'bootstrap'))).length).toBe(2);
    url=await readFile(join(root,'bootstrap/open-0001'),'utf8');tokens.push(new URL(url).searchParams.get('token')!);
    student=await context.newPage();await navigate(student,url);url='';
    // Use Jupyter's existing toggle to give the notebook/guide working space.
    await student.getByRole('tab',{name:/^File Browser/}).click();
    // Controlled synthetic media response; public video availability is not
    // claimed. Released v0.2.0 supports the HTTPS video surface, not local media.
    await student.route('https://video.example.test/reader-fixture.mp4',async route=>route.fulfill({status:200,contentType:'video/mp4',body:await readFile(join(fixture,'media/reader-fixture.mp4'))}));
    const videoResponses:Array<Record<string,unknown>>=[];
    student.on('response',response=>{
      const path=new URL(response.url()).pathname;
      if(path.endsWith('/media/reader-fixture.mp4'))videoResponses.push({path,status:response.status(),mime:response.headers()['content-type'],policy:response.headers()['content-security-policy']});
    });
    const guide=student.frameLocator('iframe[title="CourseWeave guide"]');
    await expect(guide.locator('body')).toContainText('Record validation practice');
    await guide.getByText('Course contents',{exact:true}).click();
    const navigation=guide.locator('.cw-navigation details');
    result.stage='Exercise seven surfaces';
    await navigation.getByRole('button',{name:'Open Validation lesson',exact:true}).click();
    await expect(student.locator('.lm-TabBar-tabLabel',{hasText:'validate.md'})).toBeVisible();
    await navigation.getByRole('button',{name:'Open Field rules',exact:true}).click();
    await expect(student.frameLocator('iframe[title="CourseWeave reader"]').getByRole('heading',{name:'Field rules'})).toBeVisible();
    await navigation.getByRole('button',{name:'Open Validation source',exact:true}).click();
    await expect(student.locator('.jp-CodeMirrorEditor')).toHaveCount(1);
    await navigation.getByRole('button',{name:'Open Reader test video',exact:true}).click();
    const video=student.frameLocator('iframe[title="CourseWeave reader"]').locator('video');
    await expect.poll(async()=>{
      result.video=await video.evaluate((el:HTMLVideoElement)=>({ready_state:el.readyState,network_state:el.networkState,error_code:el.error?.code??null,error_message:el.error?.message??null,codec_support:el.canPlayType('video/mp4; codecs="avc1.64000A"')}));
      result.video.responses=videoResponses;return result.video.ready_state;
    },{message:'Video metadata should load in the actual Student reader.'}).toBeGreaterThanOrEqual(1);
    await navigation.getByRole('button',{name:'Open Terminal validation instructions',exact:true}).click();
    await expect(student.locator('.jp-Terminal')).toBeVisible();
    await expect(student.locator('[data-courseweave-terminal-instructions]')).toContainText('source/validate.py');
    expect(await readFile(join(started.home,'course/terminal-result.json')).then(()=>true,()=>false)).toBe(false);
    tracker.refresh();
    const popup=context.waitForEvent('page');
    await navigation.getByRole('button',{name:'Open Python JSON reference',exact:true}).click();
    const external=await popup;await expect.poll(()=>external.url()).toContain('docs.python.org/3/library/json.html');await external.close();
    result.checks.push('All seven supported surface types opened; terminal command did not execute automatically.');
    await navigation.getByRole('button',{name:'Open Validation notebook',exact:true}).click();
    await expect(student.locator('.jp-Notebook')).toBeVisible();
    result.stage='Prediction, hints, native check and notebook';
    await guide.getByRole('textbox',{name:'Before running: predict which records pass and give the deciding field rule.',exact:true}).fill('Before running: Ada passes; the string age and missing name fail their declared rules.');
    await guide.getByRole('button',{name:'Save response',exact:true}).click();
    await guide.getByRole('button',{name:'Next authored hint',exact:true}).click();
    await guide.getByText('Self-checks (1)',{exact:true}).click();
    await guide.getByLabel('The record satisfies the declared field constraints.',{exact:true}).check();
    await guide.getByRole('button',{name:'Check answer',exact:true}).click();
    await expect(guide.locator('.cw-check').getByRole('status').filter({hasText:'Correct.'})).toContainText('Correct. Yes. The field rules pass');
    // Jupyter explicitly skips code cells while its kernel is initializing.
    // Wait for the visible native status before the deliberate Run All action.
    await expect(student.getByText('Course Python | Idle',{exact:true})).toBeVisible({timeout:30_000});
    await student.getByRole('menuitem',{name:'Run',exact:true}).click();
    await student.getByRole('menuitem',{name:'Run All Cells',exact:true}).click();
    await expect(student.locator('.jp-Notebook')).toContainText('Observed validation: [True, False, False]',{timeout:30_000});
    await student.locator('.jp-Notebook').click();await student.keyboard.press(process.platform==='darwin'?'Meta+s':'Control+s');
    await expect.poll(async()=>{
      const nb=JSON.parse(await readFile(join(started.home,'course/notebooks/practice.ipynb'),'utf8'));
      return nb.cells.filter((c:any)=>c.cell_type==='code').every((c:any)=>c.execution_count!==null);
    }).toBe(true);
    result.kernel=await inspectInstalledNotebookKernel(student,'notebooks/practice.ipynb');
    expect(Object.values(result.kernel.secret_presence)).not.toContain(true);
    result.checks.push('Prediction, hint, native check and manual Run All/Save completed in the isolated notebook.');
    result.stage='Synthetic provider and unaided restrictions';
    if(shareProvider){
      await guide.getByRole('textbox',{name:'Ask a question',exact:true}).fill('Which declared rule rejects an age written as a string?');
      await guide.getByRole('button',{name:'Send',exact:true}).click();
      await expect(guide.getByText('local teacher reply',{exact:true})).toBeVisible();
    }
    const expectedRequests=shareProvider?1:0;
    expect(provider.requests.length).toBe(expectedRequests);
    await guide.getByText('Optional activities & references',{exact:true}).click();
    await navigation.getByRole('button',{name:'Open Unaided protocol',exact:true}).click();
    // An unsent draft stays editable across activities; the policy gates Send.
    await guide.getByRole('textbox',{name:'Ask a question',exact:true}).fill('This draft must stay unsent during unaided work.');
    await expect(guide.getByRole('button',{name:'Send',exact:true})).toBeDisabled();
    await expect(guide.getByText('Assistant discussion is disabled for this activity.',{exact:true})).toBeVisible();
    expect(provider.requests.length).toBe(expectedRequests);
    result.unaided={synthetic_provider_requests_before:expectedRequests,synthetic_provider_requests_after:provider.requests.length};
    result.stage='Exit unaided work';
    await navigation.getByRole('button',{name:'Open Validation notebook',exact:true}).click();
    await guide.getByRole('textbox',{name:'Ask a question',exact:true}).fill('I have returned to assisted practice.');
    await expect(guide.getByRole('button',{name:'Send',exact:true})).toBeEnabled();
    await student.getByRole('button',{name:'Hide notification',exact:true}).click({timeout:1000}).catch(()=>undefined);
    await student.screenshot({path:join(root,'student-desktop.png')});
    await student.setViewportSize({width:390,height:844});
    await student.screenshot({path:join(root,'student-narrow-guide.png')});
    const guideBox=await student.locator('iframe[title="CourseWeave guide"]').boundingBox();
    expect(guideBox!==null&&guideBox.x>=0&&guideBox.x+guideBox.width<=390).toBe(true);
    await student.getByRole('tab',{name:'CourseWeave',exact:true}).click();
    await expect(student.locator('.jp-Notebook')).toBeVisible();
    await student.screenshot({path:join(root,'student-narrow-notebook.png')});
    result.checks.push('Narrow Student uses existing Jupyter sidebar toggles to alternate the guide and notebook.');
    result.stage='Return to Author, stop and save observations';
    await page.bringToFront();
    await panel.getByRole('button',{name:'Stop Student preview',exact:true}).click();
    await expect(panel.getByRole('heading',{name:`Student v${version} · stopped`,exact:true})).toBeVisible();
    await student.close();student=undefined;
    await panel.getByRole('button',{name:'Record observations',exact:true}).click();
    for(const name of ['Markdown','HTML','Source file','Notebook','Video','Terminal','External link','Navigated course','Used keyboard','Ran notebook','Saved notebook','Submitted prediction','Revealed hint','Answered native checks','Entered and exited unaided work'])await panel.getByLabel(name,{exact:true}).check();
    await panel.getByRole('textbox',{name:'Preview observations',exact:true}).fill(`Automated installed acceptance: all seven surfaces, prediction, hint, native check, manual notebook Run All and Save; synthetic provider ${expectedRequests} allowed request, zero additional requests in unaided activity. No real-world completion or learning claim.`);
    await panel.getByRole('button',{name:'Save preview observations',exact:true}).click();
    await expect(panel.getByText(/Your recorded observations: Automated installed acceptance/)).toBeVisible();
    await panel.getByRole('button',{name:'Keep preview files',exact:true}).click();
    await page.getByRole('button',{name:'Hide notification',exact:true}).click({timeout:1000}).catch(()=>undefined);
    await panel.getByRole('heading',{name:`Student v${version} · stopped`,exact:true}).evaluate(el=>el.scrollIntoView({block:'start'}));
    await page.screenshot({path:join(root,'author-desktop.png')});
    await page.setViewportSize({width:390,height:844});
    await panel.getByRole('heading',{name:'Student practice preview',exact:true}).evaluate(el=>el.scrollIntoView({block:'start'}));
    await page.screenshot({path:join(root,'author-narrow-inputs.png')});
    await panel.getByRole('heading',{name:`Student v${version} · stopped`,exact:true}).evaluate(el=>el.scrollIntoView({block:'start'}));
    await page.screenshot({path:join(root,'author-narrow-record.png')});
    expect(await authorFrame.locator('body').evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
    for(const [name,hash] of Object.entries(original.original_files)){
      const bytes=await readFile(join(fixture,name));expect(createHash('sha256').update(bytes).digest('hex')).toBe(hash);
      expect(await readFile(join(root,'author-home/projects/preview-practice/course',name))).toEqual(bytes);
    }
    const receipt=JSON.parse(await readFile(join(root,'author-home/projects/preview-practice/author-state/previews',previewId+'.json'),'utf8'));
    expect(receipt.files).toBe('kept');expect(receipt.observations.category).toBe('author_reported');result.saved_receipt=receipt;
    result.stage='Restart Author and reopen saved preview observations';
    const notebookPath=join(started.home,'course/notebooks/practice.ipynb');
    const savedNotebook=await readFile(notebookPath);
    await stopOwnedProcess(author,tracker);
    expect(tracker.live()).toEqual([]);
    await rm(join(root,'bootstrap'),{recursive:true});await mkdir(join(root,'bootstrap'),{mode:0o700});
    author=launch();tracker=new OwnedProcessTracker(author.pid!);trackers.push(tracker);
    await expect.poll(async()=> (await readdir(join(root,'bootstrap'))).length,{timeout:60_000}).toBe(1);
    url=await readFile(join(root,'bootstrap/open-0000'),'utf8');tokens.push(new URL(url).searchParams.get('token')!);
    await page.setViewportSize({width:1280,height:900});await navigate(page,url);url='';
    await authorFrame.getByRole('combobox',{name:'Open project',exact:true}).selectOption('preview-practice');
    await panel.getByRole('button',{name:'Reload preview inputs',exact:true}).click();
    await expect(panel.getByText(/Your recorded observations: Automated installed acceptance/)).toBeVisible();
    await expect(panel.getByRole('heading',{name:`Student v${version} · stopped`,exact:true})).toBeVisible();
    expect(await readFile(notebookPath)).toEqual(savedNotebook);
    expect(JSON.parse(await readFile(join(root,'author-home/projects/preview-practice/author-state/previews',previewId+'.json'),'utf8'))).toEqual(receipt);
    result.checks.push('Author restarted; preview observations, explicit Keep decision and saved notebook outputs remained intact.');
    result.status='passed-awaiting-visual-inspection';
  } catch(error) {
    result.status='failed';result.error=error instanceof Error?error.message.replace(/\u001b\[[0-9;]*m/g,'').slice(0,3500):'Preview journey failed.';
    for(const token of [...tokens,plantedModel,plantedSearch])result.error=result.error.replaceAll(token,'[redacted]');
    if(student)await student.screenshot({path:join(root,'student-failure.png')}).catch(()=>undefined);
    await page.screenshot({path:join(root,'author-failure.png')}).catch(()=>undefined);
    throw new Error(result.error);
  } finally {
    if(student)await student.close();
    const stop=async()=>{
      if(author.exitCode!==null||author.signalCode!==null){
        if(tracker.live().length)throw new Error('Owned descendants remain after the Author CLI exited.');
      }else await stopOwnedProcess(author,tracker);
    };
    const cleanup=await Promise.allSettled([stop(),provider.close()]);
    result.cleanup_failures=cleanup.filter(item=>item.status==='rejected').length;
    if(result.cleanup_failures)result.status='cleanup-failed';
    result.synthetic_provider_requests=provider.requests.length;
    result.author_exit={code:author.exitCode,signal:author.signalCode};
    result.owned_processes=trackers.flatMap(t=>t.snapshot());result.live_owned_processes=trackers.flatMap(t=>t.live());
    await rm(join(root,'bootstrap'),{recursive:true});
    const storage=await authorFrame.locator('body').evaluate(()=>JSON.stringify({local:Object.entries(localStorage),session:Object.entries(sessionStorage)})).catch(()=>null);
    if(storage!==null&&[...tokens,plantedModel,plantedSearch].some(secret=>storage.includes(secret)))throw new Error('Sensitive value found in browser storage.');
    result.browser_storage_checked=storage!==null;
    result.credential_files_scanned=await scanFiles(root,[...tokens,plantedModel,plantedSearch]);
    const publicResult=JSON.stringify(result,null,2)+'\n';
    if([...tokens,plantedModel,plantedSearch].some(secret=>publicResult.includes(secret)))throw new Error('Sensitive value detected in preview receipt; it was not written.');
    await writeFile(join(root,'receipt.json'),publicResult);
    expect(result.cleanup_failures).toBe(0);
  }
});

test('candidate local video retains authentication without enabling course scripts',async({page})=>{
  test.skip(!work||!process.env.COURSEWEAVE_TEST_WHEEL||version!=='0.3.0','Requires an exact candidate wheel and explicit local evidence root.');
  const root=join(work!,'local-video');await mkdir(root,{recursive:true});
  const courseRoot=join(root,'course');await cp(fixture,courseRoot,{recursive:true,errorOnExist:true});
  const manifest=JSON.parse(await readFile(join(courseRoot,'courseweave.json'),'utf8'));
  manifest.modules[0].phases[0].surfaces.find((s:any)=>s.id==='video').src='media/reader-fixture.mp4';
  await writeFile(join(courseRoot,'courseweave.json'),JSON.stringify(manifest,null,2)+'\n');
  const workspace=await launchInstalledWorkspace('learn',{courseRoot,kernelPython:python});
  const result:any={category:'installed candidate reader regression with synthetic local video bytes',status:'running',wheel_sha256:process.env.COURSEWEAVE_TEST_WHEEL_SHA256};
  try {
    await navigate(page,await workspace.bootstrapUrl());
    const guide=page.frameLocator('iframe[title="CourseWeave guide"]');
    await guide.getByText('Course contents',{exact:true}).click();
    await guide.locator('.cw-navigation details').getByRole('button',{name:'Open Reader test video',exact:true}).click();
    const reader=page.frameLocator('iframe[title="CourseWeave reader"]');
    const video=reader.locator('video');
    await expect.poll(()=>video.evaluate((el:HTMLVideoElement)=>el.readyState)).toBeGreaterThanOrEqual(1);
    await video.evaluate((el:HTMLVideoElement)=>el.play());
    await expect.poll(()=>video.evaluate((el:HTMLVideoElement)=>el.currentTime)).toBeGreaterThan(0);
    result.media=await video.evaluate((el:HTMLVideoElement)=>({duration:el.duration,current_time:el.currentTime,error_code:el.error?.code??null}));
    expect(result.media.error_code).toBeNull();
    expect(await page.locator('iframe[title="CourseWeave reader"]').getAttribute('sandbox')).toBe('allow-same-origin');
    expect(await reader.locator('script').count()).toBe(0);
    await page.screenshot({path:join(root,'local-video.png')});
    // A later HTML navigation replaces the media document and preserves the
    // existing scripts-disabled reader and course context.
    await guide.locator('.cw-navigation details').getByRole('button',{name:'Open Field rules',exact:true}).click();
    await expect(reader.getByRole('heading',{name:'Field rules',exact:true})).toBeVisible();
    expect(await page.locator('iframe[title="CourseWeave reader"]').getAttribute('srcdoc')).toBeNull();
    result.status='passed-awaiting-visual-inspection';
  } catch {
    result.status='failed';throw new Error('Installed local-video reader regression failed; inspect its bounded receipt.');
  } finally {
    await workspace.close();result.cleanup=await workspace.cleanupState();
    await writeFile(join(root,'receipt.json'),JSON.stringify(result,null,2)+'\n');
    expect(result.cleanup).toEqual({ownedProcessesAlive:false,ownedRootExists:false});
  }
});
