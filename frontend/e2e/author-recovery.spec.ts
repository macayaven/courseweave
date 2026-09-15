import { expect, test, type Page } from 'playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OwnedProcessTracker, stopOwnedProcess } from './process-cleanup';
import { scanFiles } from './credential-scan';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const python=process.env.COURSEWEAVE_AUTHOR_PREVIEW_PYTHON;
const catalog=process.env.COURSEWEAVE_AUTHOR_PREVIEW_INPUTS;
const work=process.env.COURSEWEAVE_AUTHOR_PREVIEW_WORKROOT;
const version=process.env.COURSEWEAVE_PREVIEW_STUDENT_VERSION ?? '0.3.0';
const fixture=join(repo,'tests/fixtures/author-preview-course');
const helper=join(repo,'frontend/e2e/author-preview-setup.py');

test('installed Author backup restore and process crash retain independent work',async({page,context})=>{
  test.skip(!python||!catalog||!work,'Requires a fresh installed Author wheel and isolated local evidence root.');
  const root=join(work!,'recovery');await mkdir(root,{recursive:true});await mkdir(join(root,'bootstrap'),{mode:0o700});
  const environment=Object.fromEntries(['HOME','PATH','LANG','LC_ALL','TMPDIR','UV_CACHE_DIR'].flatMap(key=>process.env[key]?[[key,process.env[key]!]]:[]));
  const seed=spawnSync(python!,['-I',helper,'seed',fixture,root,catalog!],{cwd:root,env:environment,encoding:'utf8',timeout:60_000});
  if(seed.status!==0)throw new Error('Installed recovery fixture could not be prepared.');
  const original=JSON.parse(await readFile(join(root,'seed.json'),'utf8'));
  const planted=['synthetic-recovery-model-key','synthetic-recovery-search-key'];
  const launch=()=>spawn(python!,['-I',helper,'launch',fixture,root,catalog!],{cwd:root,detached:true,stdio:['ignore','ignore','ignore'],
    env:{...environment,OPENAI_API_KEY:planted[0],BRAVE_SEARCH_API_KEY:planted[1]}});
  let author=launch(),tracker=new OwnedProcessTracker(author.pid!);
  const trackers=[tracker],tokens:string[]=[];
  let student:Page|undefined;
  const result:any={category:'fresh installed automated UI and real SIGKILL recovery; no model or search action',student_version:version,status:'running',checks:[]};
  const frame=page.frameLocator('iframe[title="CourseWeave author"]');
  const panel=frame.getByRole('region',{name:'Project backup and recovery',exact:true});
  const preview=frame.getByRole('region',{name:'Student practice preview',exact:true});
  const projectRoot=join(root,'author-home/projects/preview-practice');
  async function navigate(target:Page,file:string){
    let url=await readFile(file,'utf8');tokens.push(new URL(url).searchParams.get('token')!);
    try{await target.goto(url,{waitUntil:'domcontentloaded'});}catch{throw new Error('Owned recovery bootstrap could not open.');}
    url='';await expect.poll(()=>target.url().includes('token=')).toBe(false);
  }
  try{
    await page.setViewportSize({width:1280,height:960});
    await expect.poll(async()=>(await readdir(join(root,'bootstrap'))).length,{timeout:60_000}).toBe(1);
    await navigate(page,join(root,'bootstrap/open-0000'));
    await frame.getByRole('combobox',{name:'Open project',exact:true}).selectOption('preview-practice');
    await preview.getByRole('button',{name:'Reload preview inputs',exact:true}).click();
    await preview.getByRole('combobox',{name:'Preview Student version',exact:true}).selectOption(version);
    const starting=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/api/author/previews'));
    await preview.getByRole('button',{name:'Prepare Student preview',exact:true}).click();
    const started=await(await starting).json();result.preview_id=started.preview_id;result.preview_home=started.home;
    await expect(preview.getByRole('button',{name:'Open Student preview',exact:true})).toBeVisible({timeout:180_000});
    await preview.getByRole('button',{name:'Open Student preview',exact:true}).click();
    await expect.poll(async()=>(await readdir(join(root,'bootstrap'))).length).toBe(2);
    student=await context.newPage();await navigate(student,join(root,'bootstrap/open-0001'));
    const guide=student.frameLocator('iframe[title="CourseWeave guide"]');
    await guide.getByText('Course contents',{exact:true}).click();
    await guide.locator('.cw-navigation details').getByRole('button',{name:'Open Validation notebook',exact:true}).click();
    await expect(student.getByText('Course Python | Idle',{exact:true})).toBeVisible({timeout:30_000});
    await student.getByRole('menuitem',{name:'Run',exact:true}).click();
    await student.getByRole('menuitem',{name:'Run All Cells',exact:true}).click();
    await expect(student.locator('.jp-Notebook')).toContainText('Observed validation: [True, False, False]');
    await student.locator('.jp-Notebook').click();await student.keyboard.press(process.platform==='darwin'?'Meta+s':'Control+s');
    const notebookPath=join(started.home,'course/notebooks/practice.ipynb');
    await expect.poll(async()=>JSON.parse(await readFile(notebookPath,'utf8')).cells.filter((c:any)=>c.cell_type==='code').every((c:any)=>c.execution_count!==null)).toBe(true);
    const savedNotebook=await readFile(notebookPath);
    result.notebook_sha256=createHash('sha256').update(savedNotebook).digest('hex');
    await panel.getByText('Backup and recovery',{exact:true}).click();
    await panel.getByRole('checkbox',{name:'Pending and rejected drafts',exact:true}).check();
    await panel.getByRole('checkbox',{name:'Saved review reports',exact:true}).check();
    await panel.getByRole('button',{name:'Inspect backup selection',exact:true}).click();
    await expect(panel.getByText(/Private backup: saved course/)).toBeVisible();
    const backup=join(root,'author-backup.tar');
    await panel.getByRole('textbox',{name:'New backup file',exact:true}).fill(backup);
    const backingUp=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/api/author/backups'));
    await panel.getByRole('button',{name:'Create reviewed backup',exact:true}).focus();await page.keyboard.press('Enter');
    const backupResponse=await backingUp;expect(backupResponse.status()).toBe(201);result.backup=await backupResponse.json();
    await expect(panel.getByText('Backup saved: '+backup,{exact:true})).toBeVisible();
    expect((await readFile(backup)).includes(Buffer.from(started.home))).toBe(false);
    await panel.scrollIntoViewIfNeeded();await page.screenshot({path:join(root,'backup.png')});
    await panel.getByRole('button',{name:'Inspect restore archive',exact:true}).click();
    await expect(panel.getByText(/Restore creates a new project/)).toBeVisible();
    await panel.getByRole('textbox',{name:'Restored project ID',exact:true}).fill('recovered-practice');
    await panel.getByRole('button',{name:'Restore as new project',exact:true}).click();
    await expect(frame.getByRole('combobox',{name:'Open project',exact:true})).toHaveValue('recovered-practice');
    const restored=join(root,'author-home/projects/recovered-practice');
    for(const [name,digest] of Object.entries(original.original_files)){
      expect(createHash('sha256').update(await readFile(join(restored,'course',name))).digest('hex')).toBe(digest);
      expect(createHash('sha256').update(await readFile(join(fixture,name))).digest('hex')).toBe(digest);
    }
    expect(await readFile(notebookPath)).toEqual(savedNotebook);
    result.checks.push('Keyboard backup and explicit restore through installed Author UI; restored course/source fixture exact, separate executed notebook unchanged.');
    await panel.getByText('Backup and recovery',{exact:true}).click();await panel.scrollIntoViewIfNeeded();
    await page.screenshot({path:join(root,'restored.png')});
    await frame.getByRole('combobox',{name:'Open project',exact:true}).selectOption('preview-practice');
    await preview.getByRole('button',{name:'Reload preview inputs',exact:true}).click();
    await expect(preview.getByRole('heading',{name:`Student v${version} · running`,exact:true})).toBeVisible();
    // Two real Author tabs review the same file; only the first accepted write
    // may win. A backup inspected before that write also becomes stale.
    await panel.getByText('Backup and recovery',{exact:true}).click();
    await panel.getByRole('button',{name:'Inspect backup selection',exact:true}).click();
    await expect(panel.getByText(/Private backup: saved course/)).toBeVisible();
    const staleBackup=join(root,'stale-backup.tar');
    await panel.getByRole('textbox',{name:'New backup file',exact:true}).fill(staleBackup);
    const firstEditor=frame.getByRole('region',{name:'Lesson files',exact:true});
    await firstEditor.getByRole('textbox',{name:'File path',exact:true}).fill('lessons/validate.md');
    await firstEditor.getByRole('button',{name:'Open file',exact:true}).click();
    const baseline=await firstEditor.getByRole('textbox',{name:'Markdown source',exact:true}).inputValue();
    await firstEditor.getByRole('textbox',{name:'Markdown source',exact:true}).fill(baseline+'\nUnaccepted first-tab candidate.\n');
    await firstEditor.getByRole('button',{name:'Review file edit',exact:true}).click();
    await expect(firstEditor.getByText('Pending change saved. Review the diff before applying this file.',{exact:true})).toBeVisible();
    const second=await context.newPage();
    try{
      await second.goto(page.url(),{waitUntil:'domcontentloaded'});
      const other=second.frameLocator('iframe[title="CourseWeave author"]');
      await other.getByRole('combobox',{name:'Open project',exact:true}).selectOption('preview-practice');
      const editor=other.getByRole('region',{name:'Lesson files',exact:true});
      await editor.getByRole('textbox',{name:'File path',exact:true}).fill('lessons/validate.md');
      await editor.getByRole('button',{name:'Open file',exact:true}).click();
      const winner=baseline+'\nReviewed edit from the second Author tab.\n';
      await editor.getByRole('textbox',{name:'Markdown source',exact:true}).fill(winner);
      await editor.getByRole('button',{name:'Review file edit',exact:true}).click();
      await editor.getByRole('checkbox',{name:'I reviewed this exact diff',exact:true}).check();
      await editor.getByRole('button',{name:'Apply reviewed change',exact:true}).click();
      await expect(editor.getByText('Reviewed file applied and saved project reloaded.',{exact:true})).toBeVisible();
      await firstEditor.getByRole('checkbox',{name:'I reviewed this exact diff',exact:true}).check();
      const staleApply=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/apply'));
      await firstEditor.getByRole('button',{name:'Apply reviewed change',exact:true}).click();
      expect((await staleApply).status()).toBe(409);
      expect(await readFile(join(projectRoot,'course/lessons/validate.md'),'utf8')).toBe(winner);
      const staleArchive=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/api/author/backups'));
      await panel.getByRole('button',{name:'Create reviewed backup',exact:true}).click();
      expect((await staleArchive).status()).toBe(409);
      expect(await readFile(staleBackup).then(()=>true,()=>false)).toBe(false);
      await expect(panel.getByText('Backup selection changed; inspect the saved artifacts again.',{exact:true})).toBeVisible();
      await firstEditor.getByRole('button',{name:'Reload saved file',exact:true}).click();
      await expect(firstEditor.getByRole('textbox',{name:'Markdown source',exact:true})).toHaveValue(winner);
      expect(await readFile(notebookPath)).toEqual(savedNotebook);
      result.checks.push('Two actual Author tabs: reviewed write wins; stale apply and stale backup return 409, preserve the winning edit and separate notebook.');
      await panel.getByText('Backup selection changed; inspect the saved artifacts again.',{exact:true}).scrollIntoViewIfNeeded();
      await page.screenshot({path:join(root,'two-tabs-conflict.png')});
    }finally{await second.close();}
    tracker.refresh();result.processes_before_crash=tracker.snapshot();
    const liveRecord=JSON.parse(await readFile(join(projectRoot,'author-state/previews',started.preview_id+'.json'),'utf8'));
    expect(liveRecord.process_started).toBeTruthy();result.preview_process_identity_saved=true;
    result.stage='Real Author SIGKILL and child cleanup';author.kill('SIGKILL');
    await expect.poll(()=>tracker.live().length,{timeout:30_000}).toBe(0);
    expect(await readFile(notebookPath)).toEqual(savedNotebook);
    await student.close();student=undefined;
    await rm(join(root,'bootstrap'),{recursive:true});await mkdir(join(root,'bootstrap'),{mode:0o700});
    author=launch();tracker=new OwnedProcessTracker(author.pid!);trackers.push(tracker);
    await expect.poll(async()=>(await readdir(join(root,'bootstrap'))).length,{timeout:60_000}).toBe(1);
    await navigate(page,join(root,'bootstrap/open-0000'));
    await frame.getByRole('combobox',{name:'Open project',exact:true}).selectOption('preview-practice');
    await preview.getByRole('button',{name:'Reload preview inputs',exact:true}).click();
    await expect(preview.getByRole('heading',{name:`Student v${version} · failed`,exact:true})).toBeVisible();
    await expect(preview.getByText(/Preview was interrupted/)).toBeVisible();
    await preview.getByRole('button',{name:'Stop Student preview',exact:true}).click();
    await expect(preview.getByRole('heading',{name:`Student v${version} · stopped`,exact:true})).toBeVisible();
    await preview.getByRole('button',{name:'Keep preview files',exact:true}).click();
    await expect(preview.getByText('Assistant: off. Files: kept.',{exact:true})).toBeVisible();
    expect(await readFile(notebookPath)).toEqual(savedNotebook);
    const record=JSON.parse(await readFile(join(projectRoot,'author-state/previews',started.preview_id+'.json'),'utf8'));
    expect(record.files).toBe('kept');result.recovered_preview=record;
    await preview.scrollIntoViewIfNeeded();await page.screenshot({path:join(root,'recovered-preview.png')});
    await page.setViewportSize({width:390,height:844});
    await panel.getByText('Backup and recovery',{exact:true}).click();await panel.scrollIntoViewIfNeeded();
    expect(await frame.locator('body').evaluate(el=>el.scrollWidth<=document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({path:join(root,'recovery-narrow.png')});
    const storage=await frame.locator('body').evaluate(()=>JSON.stringify({local:Object.entries(localStorage),session:Object.entries(sessionStorage)}));
    expect([...tokens,...planted].some(secret=>storage.includes(secret))).toBe(false);result.browser_storage_checked=true;
    result.checks.push('SIGKILL stopped both owned Jupyter trees and the notebook kernel; fresh Author reopened and reconciled preview; explicit Keep retained real notebook outputs.');
    result.status='passed-awaiting-visual-inspection';
  }catch(error){
    result.status='failed';result.error=error instanceof Error?error.message.replace(/\u001b\[[0-9;]*m/g,'').slice(0,3500):'Recovery journey failed.';
    for(const secret of [...tokens,...planted])result.error=result.error.replaceAll(secret,'[redacted]');
    await page.screenshot({path:join(root,'failure.png')}).catch(()=>undefined);
    throw new Error(result.error);
  }finally{
    if(student)await student.close();
    try{if(author.exitCode===null&&author.signalCode===null)await stopOwnedProcess(author,tracker);}
    finally{
      result.live_owned_processes=trackers.flatMap(item=>item.live());
      result.owned_processes=trackers.flatMap(item=>item.snapshot());
      await rm(join(root,'bootstrap'),{recursive:true});
      result.credential_files_scanned=await scanFiles(root,[...tokens,...planted]);
      const receipt=JSON.stringify(result,null,2)+'\n';
      if([...tokens,...planted].some(secret=>receipt.includes(secret)))throw new Error('A recovery receipt contained a sensitive value and was not written.');
      await writeFile(join(root,'receipt.json'),receipt);
      expect(result.live_owned_processes).toEqual([]);
    }
  }
});
