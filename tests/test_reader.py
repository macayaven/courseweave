"""Authenticated reader serves only declared HTML and its ordinary image assets."""
import json
from pathlib import Path
import pytest
from courseweave.reader import read_reader_file
from test_agui import _manifest


def course(root: Path):
    data=_manifest()
    phase=data['modules'][0]['phases'][0]
    phase['surfaces']=[{'id':'lesson','type':'html','path':'lessons/one.html','purpose':'primary','label':'Lesson'}]
    (root/'courseweave.json').write_text(json.dumps(data))
    (root/'lessons').mkdir()
    (root/'assets').mkdir()
    (root/'lessons/one.html').write_text('<h1>Public lesson</h1><img src="../assets/diagram.svg"><script>window.mustNotRun=true</script>')
    (root/'assets/diagram.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg"><text>Loop</text></svg>')
    return data


def test_declared_html_and_its_referenced_image_are_byte_exact(tmp_path):
    course(tmp_path)
    data,mime=read_reader_file(tmp_path,'lessons/one.html')
    assert data==(tmp_path/'lessons/one.html').read_bytes() and mime=='text/html; charset=utf-8'
    data,mime=read_reader_file(tmp_path,'assets/diagram.svg')
    assert data==(tmp_path/'assets/diagram.svg').read_bytes() and mime=='image/svg+xml'


@pytest.mark.parametrize('path',['courseweave.json','unlisted.html','assets/unlisted.svg','../outside.svg','/etc/passwd','assets/../courseweave.json','assets/%64iagram.svg'])
def test_undeclared_or_ambiguous_paths_fail_closed(tmp_path,path):
    course(tmp_path)
    (tmp_path/'unlisted.html').write_text('private')
    (tmp_path/'assets/unlisted.svg').write_text('private')
    with pytest.raises(ValueError):read_reader_file(tmp_path,path)


def test_symlink_swap_and_removed_declaration_fail_closed(tmp_path):
    data=course(tmp_path)
    image=tmp_path/'assets/diagram.svg';image.unlink();image.symlink_to(tmp_path/'courseweave.json')
    with pytest.raises(ValueError):read_reader_file(tmp_path,'assets/diagram.svg')
    data['modules'][0]['phases'][0]['surfaces']=[]
    (tmp_path/'courseweave.json').write_text(json.dumps(data))
    with pytest.raises(ValueError):read_reader_file(tmp_path,'lessons/one.html')


@pytest.mark.parametrize('reference',['https://remote.test/private.svg','//remote.test/private.svg','/assets/diagram.svg','../assets/diagram.svg?secret=x','../assets/%64iagram.svg'])
def test_remote_absolute_and_query_image_references_do_not_grant_access(tmp_path,reference):
    course(tmp_path)
    (tmp_path/'lessons/one.html').write_text(f'<img src="{reference}">')
    with pytest.raises(ValueError):read_reader_file(tmp_path,'assets/diagram.svg')


def test_reader_limits_response_bytes(tmp_path):
    course(tmp_path)
    (tmp_path/'lessons/one.html').write_bytes(b'x'*262145)
    with pytest.raises(ValueError):read_reader_file(tmp_path,'lessons/one.html')
