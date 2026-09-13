import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {PhaseCard} from '../src/phase-card';
import {phase,state,digest} from './fixtures';
afterEach(cleanup);
const activity=phase({completion:{requirements:[{id:'prediction',type:'learner_record',record_kind:'text',prompt:'Predict the next message pair.'}]}});
it('saves an authored requirement using its exact coordinate and curriculum, never a completion command',async()=>{
 const save=vi.fn().mockResolvedValue(undefined);
 render(<PhaseCard moduleId="s01" phase={activity} state={state()} serviceOrigin="https://lab.test" surfaceId="lesson" onStateOperation={save} onRefresh={vi.fn()}/>);
 fireEvent.change(screen.getByLabelText('Predict the next message pair.'),{target:{value:'A tool call and reply'}});
 fireEvent.click(screen.getByRole('button',{name:'Save response'}));
 await vi.waitFor(()=>expect(save).toHaveBeenCalledWith({type:'put_record',coordinate:{module_id:'s01',phase_id:'read',requirement_id:'prediction'},curriculum_digest:digest,value:{text:'A tool call and reply'}},expect.any(AbortSignal)));
});
it('shows stale records without counting them and uses server artifact presence',()=>{
 const coordinate={module_id:'s01',phase_id:'read',requirement_id:'prediction'};
 render(<PhaseCard moduleId="s01" phase={phase({...activity,completion:{requirements:[...activity.completion!.requirements,{id:'file',type:'artifact_exists',prompt:'Keep your trace',path:'trace.md'}]}})} state={state({records:[{coordinate,value:{text:'Old answer'},kind:'text',origin:'direct_learner',requirement_digest:digest}],progress:{required_total:1,required_complete:0,phases:[{module_id:'s01',phase_id:'read',progress:'required',complete:false,requirements:[{requirement_id:'prediction',type:'learner_record',satisfied:false},{requirement_id:'file',type:'artifact_exists',satisfied:true}]}],records:[{coordinate,status:'stale'}]}})} serviceOrigin="https://lab.test" surfaceId="lesson"/>);
 expect(screen.getByText(/Stale/)).toBeInTheDocument();expect(screen.getAllByText('Old answer')[0]).toBeInTheDocument();expect(screen.getByText(/File present/)).toBeInTheDocument();expect(screen.queryByText('Activity complete')).not.toBeInTheDocument();
});
it('submits a check option and displays only authoritative deterministic feedback',async()=>{
 const save=vi.fn().mockResolvedValue(undefined);
 const check={id:'pair',type:'single_choice' as const,prompt:'Which reply belongs?',options:[{id:'a',text:'The matching call',feedback:'Correct: match the ID.'},{id:'b',text:'Any call',feedback:'Try matching the call ID.'}],correct_option_id:'a'};
 render(<PhaseCard moduleId="s01" phase={phase({learning:{checks:[check]}})} state={state()} serviceOrigin="https://lab.test" surfaceId="lesson" onStateOperation={save}/>);
 fireEvent.click(screen.getByText('Self-checks (1)'));
 expect(screen.queryByText('Correct: match the ID.')).not.toBeInTheDocument();
 fireEvent.click(screen.getByLabelText('Any call'));fireEvent.click(screen.getByRole('button',{name:'Check answer'}));
 await vi.waitFor(()=>expect(save).toHaveBeenCalledWith({type:'check_attempt',module_id:'s01',phase_id:'read',check_id:'pair',option_id:'b',curriculum_digest:digest},expect.any(AbortSignal)));
});
