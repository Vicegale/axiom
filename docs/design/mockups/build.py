#!/usr/bin/env python3
"""Inline src/tokens.css and src/data.js into each src/<name>.html and write <name>.html next to this script."""
import pathlib, re
here = pathlib.Path(__file__).parent
src = here / "src"
tokens = (src / "tokens.css").read_text()
data = (src / "data.js").read_text()
for f in sorted(src.glob("*.html")):
    s = f.read_text()
    s = s.replace('<link rel="stylesheet" href="tokens.css">', "<style>\n" + tokens + "\n</style>")
    s = s.replace('<script src="data.js"></script>', "<script>\n" + data + "\n</script>")
    assert "tokens.css" not in s and "data.js" not in s, f"{f.name}: include markers not replaced"
    (here / f.name).write_text(s)
    print("built", f.name, len(s), "bytes")
