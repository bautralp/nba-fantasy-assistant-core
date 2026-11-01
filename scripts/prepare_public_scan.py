"""Stage source, build and generated test text/images for a redacted scanner. No private inputs."""
from pathlib import Path
import shutil,sys
from check_public_boundary import ROOT,source_files,check
check()
destination=Path(sys.argv[1]).resolve()
if destination.exists() or destination==ROOT or destination.is_relative_to(ROOT):raise ValueError('Scan destination must be new and outside export')
destination.mkdir(parents=True)
for name,path in source_files(ROOT).items():
 out=destination/name;out.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(path,out)
for name in ['dist','artifacts']:
 if (ROOT/name).exists():shutil.copytree(ROOT/name,destination/name)
print('Staged reviewed source and generated build/test outputs; package cache excluded.')
