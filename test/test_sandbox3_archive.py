import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest

SOURCE = 'a' * 40
SCRIPT = (Path(__file__).parents[1] / 'scripts/install-api-sandbox-lane-candidate.sh').read_text()
VERIFY = SCRIPT.split('import json, posixpath, sys, tarfile\n', 1)[1].split('\nPY', 1)[0]
VERIFY = 'import json, posixpath, sys, tarfile\n' + VERIFY


class ArchiveTests(unittest.TestCase):
    def verify(self, extras, target='agent-runner-api-sandbox3', manifest_target=None):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'bundle.tar.gz'
            with tarfile.open(path, 'w:gz') as archive:
                data = json.dumps({'target': manifest_target or target, 'sourceSha': SOURCE}).encode()
                item = tarfile.TarInfo('candidate-manifest.json'); item.size = len(data)
                archive.addfile(item, io.BytesIO(data))
                for name, kind, link in extras:
                    item = tarfile.TarInfo(name)
                    if kind == 'link': item.type = tarfile.SYMTYPE; item.linkname = link
                    elif kind == 'hardlink': item.type = tarfile.LNKTYPE; item.linkname = link
                    else: item.size = 1
                    archive.addfile(item, io.BytesIO(b'x') if kind == 'file' else None)
            result = subprocess.run([sys.executable, '-', str(path), SOURCE, target], input=VERIFY,
                                    capture_output=True, text=True)
            return result.returncode

    def test_safe_npm_file_links_and_explicit_existing_candidate_target(self):
        extras = [('node_modules/pkg/bin.js', 'file', ''), ('node_modules/.bin/pkg', 'link', '../pkg/bin.js')]
        self.assertEqual(self.verify(extras), 0)
        self.assertEqual(self.verify(extras, target='agent-runner-api-mcp-test'), 0)
        self.assertNotEqual(self.verify(extras, manifest_target='production'), 0)

    def test_escape_links_link_ancestors_duplicates_and_hardlinks_refuse(self):
        for entries in [[('../escape', 'file', '')], [('link', 'link', '/etc/passwd')],
                        [('link', 'link', '../../outside')], [('file', 'file', ''), ('link', 'hardlink', 'file')],
                        [('file', 'file', ''), ('file', 'file', '')],
                        [('file', 'file', ''), ('dir', 'link', 'file'), ('dir/nested', 'file', '')]]:
            self.assertNotEqual(self.verify(entries), 0)


if __name__ == '__main__':
    unittest.main()
