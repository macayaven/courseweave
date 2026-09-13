"""Explicit activity authority and bounded surface binding for native learner navigation."""
from copy import deepcopy
import json
from fastapi.testclient import TestClient
from courseweave.api import create_app
from courseweave.context import resolve_context
from courseweave.manifest import parse_manifest_data
from courseweave.models import WorkspaceContext, ResolutionState
from test_agui import _manifest, AUTH, TOKEN


def course_data():
    data=_manifest(max_shared_chars=8192)
    read=data['modules'][0]['phases'][0]
    read['id']='read'
    read['surfaces']=[{'id':'lesson','type':'html','path':'lesson.html','purpose':'primary','label':'Read'}]
    check=deepcopy(read);check['id']='check';check['surfaces'][0].update(id='check',fragment='self-check',label='Self-check')
    data['modules'][0]['phases']=[read,check]
    return data


def context(phase='read',**metadata):
    return WorkspaceContext(source_id='reader',sequence=1,explicit_module_id='module-one',explicit_phase_id=phase,**metadata)


def test_explicit_phase_binds_same_path_html_only_within_selected_activity(tmp_path):
    manifest=parse_manifest_data(course_data(),tmp_path)
    for phase,surface in [('read','lesson'),('check','check')]:
        resolved=resolve_context(manifest,ResolutionState(),context(phase,active_path='lesson.html',surface_kind='html'))
        assert resolved.model_dump()=={'module_id':'module-one','phase_id':phase,'surface_id':surface,'reason':'explicit_phase'}


def test_explicit_phase_keeps_absent_mismatched_and_ambiguous_surfaces_unbound(tmp_path):
    data=course_data();manifest=parse_manifest_data(data,tmp_path)
    for metadata in [{},{'surface_kind':'html'},{'active_path':'other.html','surface_kind':'html'},{'active_path':'lesson.html','surface_kind':'notebook'}]:
        result=resolve_context(manifest,ResolutionState(last_module_id='module-one',last_phase_id='check'),context(**metadata))
        assert result.phase_id=='read' and result.surface_id is None and result.reason=='explicit_phase'
    duplicate=deepcopy(data['modules'][0]['phases'][0]['surfaces'][0]);duplicate.update(id='same-path',fragment='other')
    data['modules'][0]['phases'][0]['surfaces'].append(duplicate)
    result=resolve_context(parse_manifest_data(data,tmp_path),ResolutionState(),context(active_path='lesson.html',surface_kind='html'))
    assert result.phase_id=='read' and result.surface_id is None


def test_explicit_notebook_surface_respects_current_cell_selectors(tmp_path):
    data=course_data();data['runtime']={'type':'jupyter','kernel':{'type':'python_uv_project'}}
    data['modules'][0]['phases'][0]['surfaces']=[{'id':'cell','type':'notebook','path':'lab.ipynb','purpose':'primary','label':'Practice','selector':{'type':'cell_ids','values':['cell-a']}}]
    manifest=parse_manifest_data(data,tmp_path)
    for cell,expected in [('cell-a','cell'),('cell-b',None),(None,None)]:
        result=resolve_context(manifest,ResolutionState(),context(active_path='lab.ipynb',surface_kind='notebook',active_cell_id=cell))
        assert result.phase_id=='read' and result.surface_id==expected


def test_explicit_surfaces_require_matching_tags_and_video_position(tmp_path):
    data = course_data()
    data['runtime'] = {'type': 'jupyter', 'kernel': {'type': 'python_uv_project'}}
    surfaces = data['modules'][0]['phases'][0]['surfaces']
    surfaces[:] = [{'id': 'tags', 'type': 'notebook', 'path': 'lab.ipynb',
        'purpose': 'primary', 'label': 'Tagged practice',
        'selector': {'type': 'cell_tags', 'values': ['a', 'b'], 'match': 'all'}}]
    manifest = parse_manifest_data(data, tmp_path)
    for tags, expected in [([], None), (['a'], None), (['a', 'b'], 'tags')]:
        result = resolve_context(manifest, ResolutionState(), context(
            active_path='lab.ipynb', surface_kind='notebook', active_cell_tags=tags))
        assert result.surface_id == expected and result.reason == 'explicit_phase'
    surfaces[:] = [{'id': 'clip', 'type': 'video', 'src': 'clip.mp4',
        'purpose': 'primary', 'label': 'Clip', 'start_seconds': 10, 'end_seconds': 20}]
    manifest = parse_manifest_data(data, tmp_path)
    for seconds, expected in [(None, None), (9, None), (10, 'clip'), (19, 'clip'), (20, None)]:
        result = resolve_context(manifest, ResolutionState(), context(
            active_path='clip.mp4', surface_kind='video', video_seconds=seconds))
        assert result.surface_id == expected and result.phase_id == 'read'


def test_lesson_scope_after_deliberate_native_phase_navigation_requires_explicit_use_and_omits_answers(tmp_path):
    (tmp_path/'courseweave.json').write_text(json.dumps(course_data()))
    (tmp_path/'lesson.html').write_text('<p>Public lesson text</p><details id="self-check"><summary>Reference</summary>HIDDEN SOLUTION</details>')
    app=create_app(tmp_path,capability_token=TOKEN)
    with TestClient(app) as client:
        for sequence,phase in enumerate(['read','check'],1):
            selected=context(phase,active_path='lesson.html',surface_kind='html').model_dump()|{'sequence':sequence}
            accepted=client.post('/api/context',headers=AUTH,json=selected)
            assert accepted.status_code==200 and accepted.json()['surface_id'] in {'lesson','check'}
            if phase=='read': assert app.state.lesson_scopes=={}
            scoped=client.post('/api/guide/lesson',headers=AUTH,json={'thread_id':'conversation','source_id':'reader','action':'use_lesson'})
            assert scoped.status_code==200
            assert scoped.json()['scope']['phase_id']==phase
            assert scoped.json()['scope']['omitted_sections'] is True
            assert 'HIDDEN SOLUTION' not in next(iter(app.state.lesson_scopes.values())).excerpt
