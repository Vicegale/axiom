#!/usr/bin/env python3
"""Inline the local stylesheets and scripts of each src/<name>.html (tokens.css, data.js, steward-*.css/js, ...) and write <name>.html next to this script."""
import pathlib, re
here = pathlib.Path(__file__).parent
src = here / "src"
for f in sorted(src.glob("*.html")):
    s = f.read_text()
    s = re.sub(r'<link rel="stylesheet" href="([\w.-]+\.css)">', lambda m: "<style>\n" + (src / m.group(1)).read_text() + "\n</style>", s)
    s = re.sub(r'<script src="([\w.-]+\.js)"></script>', lambda m: "<script>\n" + (src / m.group(1)).read_text() + "\n</script>", s)
    assert not re.search(r'(href|src)="[\w.-]+\.(css|js)"', s), f"{f.name}: include markers not replaced"
    (here / f.name).write_text(s)
    print("built", f.name, len(s), "bytes")
