import { expect, type Page } from 'playwright/test';

/** Execute an in-memory probe through the actual native notebook kernel. */
export async function inspectInstalledNotebookKernel(page: Page, notebookPath: string) {
  const discover = () => page.evaluate(async (path) => {
    const config=JSON.parse(document.querySelector('#jupyter-config-data')!.textContent!);
    const headers={Authorization:`token ${config.token}`};
    const response=await fetch(`${config.baseUrl}api/sessions`,{headers});
    if(!response.ok) throw new Error('Native kernel session discovery failed.');
    const sessions=await response.json();
    return sessions.find((row:any)=>row.path===path)?.kernel?.id ?? null;
  }, notebookPath);
  await expect.poll(discover, {timeout:30000}).toEqual(expect.any(String));
  const kernelId=await discover();
  return page.evaluate(async (id) => {
    const config=JSON.parse(document.querySelector('#jupyter-config-data')!.textContent!);
    const headers={Authorization:`token ${config.token}`};
    const specs=await (await fetch(`${config.baseUrl}api/kernelspecs`,{headers})).json();
    const url=new URL(`${config.baseUrl}api/kernels/${id}/channels`,location.origin);
    url.protocol=location.protocol==='https:'?'wss:':'ws:';
    const session=crypto.randomUUID();url.searchParams.set('session_id',session);
    const msgId=crypto.randomUUID();
    const code=[
      'import json, os, sys',
      'from ipykernel.kernelapp import IPKernelApp',
      'cw_app = IPKernelApp.instance()',
      'print(json.dumps({"executable":sys.executable,"prefix":sys.prefix,"base_prefix":sys.base_prefix,"secret_presence":{name:name in os.environ for name in ["OPENAI_API_KEY","ANTHROPIC_API_KEY","AGENT_KB_LITELLM_KEY","COURSEWEAVE_CAPABILITY_TOKEN","JUPYTER_TOKEN"]},"transport":cw_app.transport,"bind_ip":cw_app.ip,"message_authentication":cw_app.session.signature_scheme,"message_key_present":bool(cw_app.session.key)}))',
    ].join('\n');
    const execution=await new Promise<Record<string,unknown>>((resolve,reject)=>{
      const socket=new WebSocket(url);
      const timer=setTimeout(()=>{socket.close();reject(new Error('Native kernel execution timed out.'));},30000);
      let output='';let failed=false;
      const finish=(error?:Error)=>{clearTimeout(timer);socket.close();if(error)reject(error);else {try{resolve(JSON.parse(output.trim()));}catch{reject(new Error('Native kernel probe returned invalid evidence.'));}}};
      socket.onerror=()=>finish(new Error('Native kernel channel failed.'));
      socket.onopen=()=>socket.send(JSON.stringify({header:{msg_id:msgId,username:'courseweave-acceptance',session,msg_type:'execute_request',version:'5.3',date:new Date().toISOString()},parent_header:{},metadata:{},content:{code,silent:false,store_history:false,user_expressions:{},allow_stdin:false,stop_on_error:true},channel:'shell',buffers:[]}));
      socket.onmessage=(event)=>{
        if(typeof event.data!=='string')return;
        const message=JSON.parse(event.data);
        if(message.parent_header?.msg_id!==msgId)return;
        if(message.msg_type==='stream'||message.header?.msg_type==='stream')output+=message.content.text;
        if(message.header?.msg_type==='error')failed=true;
        if(message.header?.msg_type==='status'&&message.content.execution_state==='idle')finish(failed?new Error('Native kernel probe failed.'):undefined);
      };
    });
    return {kernel_name:specs.default,allowed_kernels:Object.keys(specs.kernelspecs),...execution};
  },kernelId);
}
