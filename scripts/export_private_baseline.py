"""Export an approved historical file only into an explicit external private output root."""
from pathlib import Path
import argparse,json,os
from migration_baselines import ROOT, read_historical, PrivateValidationRequired

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--identity', required=True)
    parser.add_argument('--path', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    try:
        raw = read_historical(args.identity, args.path)
        configured = os.environ.get('NFA_PRIVATE_OUTPUT_ROOT')
        if not configured:
            raise PrivateValidationRequired('PRIVATE_OUTPUT_ROOT_REQUIRED')
        root = Path(configured).resolve()
        target = (root / args.output).resolve()
        if root == ROOT or root.is_relative_to(ROOT) or not target.is_relative_to(root):
            raise ValueError('Private output must remain outside the public export')
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)
    except (PrivateValidationRequired, ValueError) as error:
        print(json.dumps({'status': 'blocked', 'scope': 'private-only', 'reason': str(error)}))
        raise SystemExit(2)
