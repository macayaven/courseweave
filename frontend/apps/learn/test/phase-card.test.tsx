import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {StrictMode} from 'react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {PhaseCard} from '../src/phase-card';
import {phase,state,digest} from './fixtures';
import type {Requirement} from '@courseweave/ui/courseweave-types';
afterEach(cleanup);
const textRequirement:Requirement={id:'reflection',type:'learner_record',record_kind:'text',prompt:'Reflection'};
const evidenceRequirement:Requirement={id:'evidence',type:'learner_record',record_kind:'evidence',prompt:'Evidence reference'};
const review=phase({id:'review',title:'Review',completion:{requirements:[textRequirement,evidenceRequirement]}});
const common={moduleId:'m01',serviceOrigin:'https://courseweave.test',surfaceId:'lesson'};
describe('PhaseCard canonical activity',()=>{
 it.each(['generic','orientation','reading','media','prediction','experiment','practice','review','project'] as const)('uses authored requirements for the %s experience without inventing gates or checks',experience=>{
  render(<PhaseCard {...common} phase={phase({experience:{type:'builtin',id:experience},completion:{requirements:[textRequirement]}})} state={state()}/>);
  expect(screen.getByLabelText('Reflection')).toBeInTheDocument();expect(screen.getByRole('button',{name:'Open Read the lesson'})).toBeInTheDocument();
  expect(screen.queryByText(/Release checks|Teacher help is locked during audit|Show a gentle hint/)).not.toBeInTheDocument();
 });
 it.each(['learner_record','artifact_exists'] as const)('renders completion solely from authoritative %s progress',type=>{
  const progress={required_total:1,required_complete:1,phases:[{module_id:'m01',phase_id:'read',progress:'required' as const,complete:true,requirements:[{requirement_id:'r',type,satisfied:true}]}],records:[]};
  render(<PhaseCard {...common} phase={phase()} state={state({progress})}/>);expect(screen.getByText('Activity complete')).toBeInTheDocument();
 });
 it.each(['orientation','practice','project'] as const)('sends only trusted IDs for %s navigation',experience=>{
  const postMessage=vi.fn();render(<PhaseCard {...common} phase={phase({experience:{type:'builtin',id:experience}})} state={state()} parentWindow={{postMessage}}/>);
  fireEvent.click(screen.getByRole('button',{name:'Open Read the lesson'}));expect(postMessage).toHaveBeenCalledOnce();expect(postMessage).toHaveBeenCalledWith({type:'courseweave.open-surface.v1',moduleId:'m01',phaseId:'read',surfaceId:'lesson'},'https://courseweave.test');
 });
 it.each([null,'missing'])('does not navigate when the resolved surface is %s',surfaceId=>{
  const postMessage=vi.fn();render(<PhaseCard {...common} surfaceId={surfaceId} phase={phase()} state={state()} parentWindow={{postMessage}}/>);expect(screen.queryByRole('button',{name:/Open/})).not.toBeInTheDocument();expect(postMessage).not.toHaveBeenCalled();
 });
 it('records exact authored text and structured evidence through the canonical state contract under StrictMode',async()=>{
  const save=vi.fn().mockResolvedValue(undefined);render(<StrictMode><PhaseCard {...common} phase={review} state={state()} onStateOperation={save}/></StrictMode>);
  fireEvent.change(screen.getByLabelText('Reflection'),{target:{value:'what I learned'}});fireEvent.click(screen.getAllByRole('button',{name:'Save response'})[0]!);
  await vi.waitFor(()=>expect(save).toHaveBeenCalledWith({type:'put_record',coordinate:{module_id:'m01',phase_id:'review',requirement_id:'reflection'},curriculum_digest:digest,value:{text:'what I learned'}},expect.any(AbortSignal)));
  fireEvent.change(screen.getByLabelText('Reference label 1'),{target:{value:'My trace'}});fireEvent.change(screen.getByLabelText('Path or HTTPS URL 1'),{target:{value:'notes/trace.md'}});fireEvent.click(screen.getAllByRole('button',{name:'Save response'})[1]!);
  await vi.waitFor(()=>expect(save).toHaveBeenCalledWith({type:'put_record',coordinate:{module_id:'m01',phase_id:'review',requirement_id:'evidence'},curriculum_digest:digest,value:{references:[{label:'My trace',path:'notes/trace.md'}]}},expect.any(AbortSignal)));expect(save).toHaveBeenCalledTimes(2);
 });
 it('preserves drafts and refreshes once after a conflict without replay',async()=>{
  const save=vi.fn().mockRejectedValue({status:409,code:'revision_mismatch'});const refresh=vi.fn().mockResolvedValue(undefined);render(<PhaseCard {...common} phase={review} state={state()} onStateOperation={save} onRefresh={refresh}/>);
  fireEvent.change(screen.getByLabelText('Reflection'),{target:{value:'retain reflection'}});fireEvent.click(screen.getAllByRole('button',{name:'Save response'})[0]!);
  expect(await screen.findByText('State changed; review the refreshed course state.')).toBeInTheDocument();expect(screen.getByLabelText('Reflection')).toHaveValue('retain reflection');expect(save).toHaveBeenCalledOnce();expect(refresh).toHaveBeenCalledOnce();
 });
 it('enters recovery when conflict refresh fails without an auth status',async()=>{
  const recovery=vi.fn();render(<PhaseCard {...common} phase={review} state={state()} onStateOperation={vi.fn().mockRejectedValue({code:'revision_mismatch'})} onRefresh={vi.fn().mockRejectedValue(Error('offline'))} onRecovery={recovery}/>);
  fireEvent.change(screen.getByLabelText('Reflection'),{target:{value:'keep'}});fireEvent.click(screen.getAllByRole('button',{name:'Save response'})[0]!);
  expect(await screen.findByText('State refresh failed. Reconnect to continue.')).toBeInTheDocument();expect(recovery).toHaveBeenCalledOnce();
 });
 it('resets requirement drafts when the trusted activity key changes',()=>{
  const view=render(<PhaseCard {...common} key="a" phase={review} state={state()}/>);fireEvent.change(screen.getByLabelText('Reflection'),{target:{value:'only A'}});
  view.rerender(<PhaseCard {...common} key="b" phase={{...review,id:'review-b'}} state={state()}/>);expect(screen.getByLabelText('Reflection')).toHaveValue('');
 });
 it('keeps drafts editable but does not write during recovery',()=>{
  const save=vi.fn();render(<PhaseCard {...common} phase={review} state={state()} onStateOperation={save} recovery/>);fireEvent.change(screen.getByLabelText('Reflection'),{target:{value:'keep'}});expect(screen.getByLabelText('Reflection')).toHaveValue('keep');expect(screen.getAllByRole('button',{name:'Save response'})[0]).toBeDisabled();expect(save).not.toHaveBeenCalled();
 });
});
