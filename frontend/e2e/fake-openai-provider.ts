// Shared local synthetic provider; never evidence of a live model.
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { Socket } from 'node:net';

export async function startFakeOpenAiProvider(learning?: Record<string,unknown>) {
  const requests: Array<{ path: string; authorization: string | undefined; body: Record<string, unknown> }> = [];
  const sockets = new Set<Socket>();
  let hold = false;
  let release: (()=>void) | undefined;
  const server = createHttpServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>; } catch { /* rejected below */ }
      requests.push({ path: incoming.url ?? '', authorization: incoming.headers.authorization, body });
      if (incoming.method !== 'POST' || incoming.url?.split('?', 1)[0] !== '/v1/chat/completions' ) {
        const error = Buffer.from('{"error":{"message":"unexpected local test request"}}');
        response.writeHead(400, { 'content-type': 'application/json', 'content-length': error.length }).end(error);
        return;
      }
      const messages=body.messages as Array<{role:string}>|undefined;
      const toolNames=(body.tools as Array<{function:{name:string}}>|undefined)?.map(t=>t.function.name)??[];
      if(learning && toolNames.includes('suggest_activity_learning') && messages?.at(-1)?.role!=='tool') {
        const result=JSON.stringify({id:'synthetic-learning-tool',object:'chat.completion',created:1,model:'stub-model',choices:[{index:0,message:{role:'assistant',content:'A scoped suggestion for review.',tool_calls:[{id:'learning-call-'+requests.length,type:'function',function:{name:'suggest_activity_learning',arguments:JSON.stringify({summary:'Clarify selected activity Learning',learning})}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:40,completion_tokens:30,total_tokens:70}});
        response.writeHead(200,{'content-type':'application/json'}).end(result);return;
      }
      if (body.stream !== true) {
        const result = JSON.stringify({id:'synthetic-completion',object:'chat.completion',created:1,model:'stub-model',choices:[{index:0,message:{role:'assistant',content:'local teacher reply'},finish_reason:'stop'}],usage:{prompt_tokens:30,completion_tokens:3,total_tokens:33}});
        response.writeHead(200, {'content-type':'application/json'}).end(result);
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: '+JSON.stringify({id:'synthetic-stream',object:'chat.completion.chunk',created:1,model:'stub-model',choices:[{index:0,delta:{role:'assistant',content:'local teacher '},finish_reason:null}]})+'\n\n');
      const finish = () => response.end('data: '+JSON.stringify({id:'synthetic-stream',object:'chat.completion.chunk',created:1,model:'stub-model',choices:[{index:0,delta:{content:'reply'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
      if (hold) { hold=false; release=finish; } else finish();
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  try {
    await new Promise<void>((resolveListen, rejectListen) => server.listen(0, '127.0.0.1', resolveListen).once('error', rejectListen));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Could not bind the local fake provider.');
    return {
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      requests,
      holdNext: () => { hold=true; },
      release: () => { if(!release) throw new Error("No held provider response"); release(); release=undefined; },
      close: async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolveClose, rejectClose) => (
          server as HttpServer
        ).close((error) => error ? rejectClose(error) : resolveClose()));
      },
    };
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    if (server.listening) {
      try {
        await new Promise<void>((resolveClose, rejectClose) => server.close((closeError) => (
          closeError ? rejectClose(closeError) : resolveClose()
        )));
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Local fake provider setup failed and cleanup also failed.',
          { cause: error },
        );
      }
    }
    throw error;
  }
}
