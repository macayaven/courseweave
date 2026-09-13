import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import type {AguiEvent,TurnContextMetadata} from '@courseweave/ui';
import {TeacherThread} from '../src/teacher-thread';
import fixture from './fixtures/learner-events.json';
afterEach(cleanup);
function eventsFor(body:{threadId:string;runId:string;forwardedProps:{source_id?:string}}):AguiEvent[]{
 return (structuredClone(fixture.events) as unknown as AguiEvent[]).map(event=>{
  if(event.type==='RUN_STARTED'||event.type==='RUN_FINISHED')return {...event,threadId:body.threadId,runId:body.runId};
  if(event.type==='CUSTOM'&&event.name==='courseweave.turn_context')return {...event,value:{...event.value as TurnContextMetadata,run_id:body.runId,source_id:body.forwardedProps.source_id}};
  return event;
 });
}
const wire=(events:AguiEvent[])=>events.map(event=>`data: ${JSON.stringify(event)}\n\n`).join('');
const common={sourceId:'lesson-source',allowedShareKinds:[],maxShareChars:8192,onProposal:vi.fn(),onRefresh:vi.fn(),activityKey:'module-one/phase-one',activityLabel:'Module one · Reading'};
it('freezes a readable accepted activity label and multiline answer while navigation changes',async()=>{
 let stream!:ReadableStreamDefaultController<Uint8Array>;let remaining:AguiEvent[]=[];
 const postGuide=vi.fn(async body=>{const events=eventsFor(body);remaining=events.slice(3);return new Response(new ReadableStream({start(controller){stream=controller;controller.enqueue(new TextEncoder().encode(wire(events.slice(0,3))));}}));});
 const onProvider=vi.fn();const client={postGuide,share:vi.fn(),createProposal:vi.fn()};
 const view=render(<TeacherThread {...common} client={client} onProvider={onProvider}/>);
 fireEvent.change(screen.getByLabelText('Ask a question'),{target:{value:'Explain the pairing invariant'}});fireEvent.click(screen.getByRole('button',{name:'Send'}));
 await vi.waitFor(()=>expect(postGuide).toHaveBeenCalledOnce());
 view.rerender(<TeacherThread {...common} activityKey="module-two/practice" activityLabel="Module two · Practice" client={client} onProvider={onProvider}/>);
 await act(async()=>{stream.enqueue(new TextEncoder().encode(wire(remaining)));stream.close();});
 expect(screen.getByText('Module one · Reading')).toBeInTheDocument();expect(screen.queryByText('Module two · Practice')).not.toBeInTheDocument();
 expect(screen.getByText(/Pair the call ID/).textContent).toContain('\n\n    messages.append(result)\n\n');expect(onProvider).toHaveBeenCalledWith('ready');
});
it('rejects selected-activity answers missing accepted context and keeps the question retryable',async()=>{
 const postGuide=vi.fn(async body=>new Response(wire(eventsFor(body).filter(event=>event.name!=='courseweave.turn_context'))));const onProvider=vi.fn();
 render(<TeacherThread {...common} client={{postGuide,share:vi.fn(),createProposal:vi.fn()}} onProvider={onProvider}/>);
 fireEvent.change(screen.getByLabelText('Ask a question'),{target:{value:'Do not relabel me'}});fireEvent.click(screen.getByRole('button',{name:'Send'}));
 await screen.findByRole('button',{name:'Retry'});expect(screen.queryByText(/Pair the call ID/)).not.toBeInTheDocument();expect(onProvider).not.toHaveBeenCalledWith('ready');expect(screen.getByLabelText('Ask a question')).toHaveValue('Do not relabel me');
});
it('retries a failed ordinary turn without duplicating its submitted question or replaying Share',async()=>{
 const postGuide=vi.fn().mockRejectedValueOnce({code:'not_configured'}).mockImplementation(async body=>new Response(wire(eventsFor(body))));const share=vi.fn();
 render(<TeacherThread {...common} client={{postGuide,share,createProposal:vi.fn()}} onProvider={vi.fn()}/>);
 fireEvent.change(screen.getByLabelText('Ask a question'),{target:{value:'One question'}});fireEvent.click(screen.getByRole('button',{name:'Send'}));fireEvent.click(await screen.findByRole('button',{name:'Retry'}));
 await vi.waitFor(()=>expect(screen.getByLabelText('Ask a question')).toHaveValue(''));
 expect(screen.getAllByText('One question')).toHaveLength(1);expect(share).not.toHaveBeenCalled();expect(postGuide).toHaveBeenCalledTimes(2);
});

it("does not establish Ready for a newly closed gate with terminal deterministic text and no provider evidence", async () => {
  const onProvider = vi.fn();
  const postGuide = vi.fn(
    async (body) =>
      new Response(
        wire(
          eventsFor(body)
            .filter(
              (event) => event.name !== "courseweave.provider_outcome",
            )
            .map((event) =>
              event.name === "courseweave.turn_context"
                ? {
                    ...event,
                    value: {
                      ...(event.value as TurnContextMetadata),
                      policy: {
                        ...(event.value as TurnContextMetadata).policy!,
                        provider_callable: false,
                        unmet_requirement_ids: ["response"],
                      },
                    },
                  }
                : event,
            ),
        ),
      ),
  );
  render(
    <TeacherThread
      {...common}
      client={{ postGuide, share: vi.fn(), createProposal: vi.fn() }}
      onProvider={onProvider}
    />,
  );
  fireEvent.change(screen.getByLabelText("Ask a question"), {
    target: { value: "Discuss after the gate changed" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByText("Answered");
  expect(screen.getByText(/Pair the call ID/)).toBeInTheDocument();
  expect(onProvider).not.toHaveBeenCalledWith("ready");
});
it.each(["interrupted", "finished"] as const)(
  "keeps streaming deltas out of announcements, then announces %s once without moving composer focus",
  async (terminal) => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    let events: AguiEvent[] = [];
    const postGuide = vi.fn(async (body) => {
      events = eventsFor(body);
      return new Response(
        new ReadableStream({
          start(controller) {
            stream = controller;
            controller.enqueue(
              new TextEncoder().encode(wire(events.slice(0, 3))),
            );
          },
        }),
      );
    });
    render(
      <TeacherThread
        {...common}
        client={{ postGuide, share: vi.fn(), createProposal: vi.fn() }}
        onProvider={vi.fn()}
      />,
    );
    const composer = screen.getByLabelText("Ask a question");
    fireEvent.change(composer, { target: { value: "Explain carefully" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    composer.focus();
    await vi.waitFor(() => expect(postGuide).toHaveBeenCalledOnce());
    const transcript = screen.getByLabelText("Conversation");
    expect(transcript).toHaveAttribute("aria-live", "off");
    const announcement = screen.getByRole("status", {
      name: "Answer updates",
    });
    expect(announcement).toBeEmptyDOMElement();
    const deltas = events.filter(
      (event) => event.type === "TEXT_MESSAGE_CONTENT",
    );
    for (const delta of deltas.slice(0, 3)) {
      await act(async () =>
        stream.enqueue(new TextEncoder().encode(wire([delta]))),
      );
      expect(announcement).toBeEmptyDOMElement();
    }
    expect(composer).toHaveFocus();
    await act(async () => {
      if (terminal === "finished")
        stream.enqueue(new TextEncoder().encode(wire(events.slice(6))));
      stream.close();
    });
    expect(announcement.textContent).toMatch(
      terminal === "finished" ? /Answer complete/ : /Answer interrupted/,
    );
    expect(announcement.textContent!.length).toBeLessThan(200);
    expect(announcement).toHaveAttribute("aria-atomic", "true");
    expect(composer).toHaveFocus();
  },
);
