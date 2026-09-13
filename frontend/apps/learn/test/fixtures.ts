import type {CourseManifest,CoursePhase,LearnerState} from '@courseweave/ui/courseweave-types';
export const digest = `sha256:${'a'.repeat(64)}`;
export function phase(overrides:Partial<CoursePhase>={}):CoursePhase {return {
 id:'read',title:'Reading',progress:'required',experience:{type:'builtin',id:'reading'},
 surfaces:[{id:'lesson',type:'html',purpose:'primary',label:'Read the lesson',path:'lessons/a.html'}],
 completion:{requirements:[]},teacher:{access:{mode:'available',requires:[]},guidance:{style:{type:'builtin',id:'explanatory'},hint_level:'graduated'},sharing:{allow:[]},proposals:{allow:[]}},...overrides
};}
export function course(overrides:Partial<CourseManifest>={}):CourseManifest {return {
 schema_version:2,id:'course',title:'Course',description:'A guided course',entry_module_id:'s01',
 policies:{content_sharing:'explicit_only',allowed_share_kinds:['selection','cell','output'],max_shared_chars:8192,allowed_proposal_types:['profile','course'],durable_mutation:'proposal_or_direct_student_action',terminal_execution:'student_only',conversation_memory:'session_only',workspace_write_globs:[]},
 modules:[{id:'s01',title:'Foundations',description:'',phases:[phase()]}],...overrides
};}
export function state(overrides:Partial<LearnerState>={}):LearnerState {return {
 schema_version:2,course_id:'course',root_fingerprint:'root',revision:1,records:[],imports:[],attempts:[],preferences:{enabled:false,explanation:'balanced',practice:'standard'},time_budget_minutes:null,profile:{},audit:[],curriculum_digest:digest,
 progress:{required_total:1,required_complete:0,phases:[],records:[]},teacher_availability:{'s01/read':{mode:'available',provider_callable:true,unmet_requirement_ids:[],guidance:phase().teacher.guidance,allowed_share_kinds:[],allowed_proposal_types:[],max_shared_chars:8192}},attempt_statuses:[],...overrides
};}
