import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {StrictMode} from 'react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {PredictionCard} from '../src/prediction-card';
import {state,digest} from './fixtures';
import type {LearnerState,Requirement} from '@courseweave/ui/courseweave-types';
afterEach(cleanup);
const requirement:Requirement={id:'prediction-1',type:'learner_record',record_kind:'text',prompt:'Your prediction'};
const common={moduleId:'s01',phaseId:'predict',requirement};
const coordinate={module_id:'s01',phase_id:'predict',requirement_id:'prediction-1'};
const saved=()=>state({revision:3,records:[{coordinate,value:{text:'my prediction'},kind:'text',origin:'direct_learner',requirement_digest:digest}],progress:{required_total:1,required_complete:1,phases:[],records:[{coordinate,status:'valid'}]}});
describe('authored prediction record',()=>{
 it('shows the valid server-recorded value instead of fabricating a generic prediction',()=>{
  const view=render(<PredictionCard {...common} state={state({revision:2})}/>);expect(screen.queryByText('Saved response')).not.toBeInTheDocument();
  view.rerender(<PredictionCard {...common} state={saved()}/>);expect(screen.getByText('Saved response')).toBeInTheDocument();expect(screen.getByText('my prediction')).toBeInTheDocument();
 });
 it('sends the exact requirement coordinate and curriculum digest',async()=>{
  const save=vi.fn().mockResolvedValue(undefined);render(<PredictionCard {...common} state={state({revision:2})} onStateOperation={save}/>);
  fireEvent.change(screen.getByLabelText('Your prediction'),{target:{value:'my prediction'}});fireEvent.click(screen.getByRole('button',{name:'Save response'}));
  await vi.waitFor(()=>expect(save).toHaveBeenCalledWith({type:'put_record',coordinate,curriculum_digest:digest,value:{text:'my prediction'}},expect.any(AbortSignal)));
 });
 it('preserves typed text and refreshes once after a revision mismatch',async()=>{
  const refresh=vi.fn().mockResolvedValue(undefined),save=vi.fn().mockRejectedValue({code:'revision_mismatch'});render(<PredictionCard {...common} state={state()} onStateOperation={save} onRefresh={refresh}/>);
  fireEvent.change(screen.getByLabelText('Your prediction'),{target:{value:'retain me'}});fireEvent.click(screen.getByRole('button',{name:'Save response'}));
  expect(await screen.findByText('State changed; review the refreshed course state.')).toBeInTheDocument();expect(screen.getByLabelText('Your prediction')).toHaveValue('retain me');expect(refresh).toHaveBeenCalledOnce();expect(save).toHaveBeenCalledOnce();
 });
 it('enters recovery when the conflict refresh fails',async()=>{
  const recovery=vi.fn();render(<PredictionCard {...common} state={state()} onStateOperation={vi.fn().mockRejectedValue({code:'revision_mismatch'})} onRefresh={vi.fn().mockRejectedValue(Error('offline'))} onRecovery={recovery}/>);
  fireEvent.change(screen.getByLabelText('Your prediction'),{target:{value:'retain me'}});fireEvent.click(screen.getByRole('button',{name:'Save response'}));expect(await screen.findByText('State refresh failed. Reconnect to continue.')).toBeInTheDocument();expect(recovery).toHaveBeenCalledOnce();
 });
 it('disables duplicate submission while a request is in flight',async()=>{
  let resolve!:()=>void;const save=vi.fn(()=>new Promise<void>(done=>{resolve=done;}));render(<PredictionCard {...common} state={state()} onStateOperation={save}/>);
  fireEvent.change(screen.getByLabelText('Your prediction'),{target:{value:'one attempt'}});fireEvent.click(screen.getByRole('button',{name:'Save response'}));expect(screen.getByRole('button',{name:'Saving response'})).toBeDisabled();fireEvent.click(screen.getByRole('button',{name:'Saving response'}));expect(save).toHaveBeenCalledOnce();resolve();await screen.findByText('Response saved.');
 });
 it('continues a successful record lifecycle under StrictMode',async()=>{
  const save=vi.fn().mockResolvedValue(undefined);render(<StrictMode><PredictionCard {...common} state={state()} onStateOperation={save}/></StrictMode>);fireEvent.change(screen.getByLabelText('Your prediction'),{target:{value:'strict success'}});fireEvent.click(screen.getByRole('button',{name:'Save response'}));expect(await screen.findByText('Response saved.')).toBeInTheDocument();expect(screen.getByRole('button',{name:'Save response'})).not.toBeDisabled();expect(save).toHaveBeenCalledOnce();
 });
 it('clears drafts for a different trusted activity',()=>{
  const view=render(<PredictionCard key="a" {...common} state={state()}/>);fireEvent.change(screen.getByLabelText('Your prediction'),{target:{value:'only A'}});view.rerender(<PredictionCard key="b" {...common} phaseId="predict-b" state={state()}/>);expect(screen.getByLabelText('Your prediction')).toHaveValue('');
 });
 it('keeps a draft editable but does not write during recovery',()=>{
  const save=vi.fn();render(<PredictionCard {...common} state={state()} onStateOperation={save} recovery/>);fireEvent.change(screen.getByLabelText('Your prediction'),{target:{value:'keep'}});expect(screen.getByLabelText('Your prediction')).toHaveValue('keep');expect(screen.getByRole('button',{name:'Save response'})).toBeDisabled();expect(save).not.toHaveBeenCalled();
 });
});
