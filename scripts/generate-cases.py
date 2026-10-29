#!/usr/bin/env python3
"""Applications that show more than one kind of problem at once.

The dataset gives each application one profile. This regenerates the
applications listed in CASES with several profiles combined, through the
dataset's own generator (../raiffeisen_50_companii/generate_dataset.py), so
their documents and tables are made exactly like the rest. Only those
applications change: their PDFs in public/documents/<dossier>/, their tables in
public/data/portfolio.json and their expected results in
tests/fixtures/oracle.json (tests only).

    python3 scripts/generate-cases.py
"""
from __future__ import annotations
import csv, json, shutil, sys, tempfile, types
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATASET = ROOT.parent / 'raiffeisen_50_companii'

# Sphera Franchise Group: a defendant in a lawsuit with material exposure (Legal) and collateral below 110% of the loan (Finance).
# Both are conditions: the case can be worked by the two departments, resolved and signed.
CASES = {48: {'litigiu_parat', 'garantii_insuficiente'}}
DESCRIPTIONS = {48: 'Litigiu fictiv ca parat cu expunere materiala si garantii sub 110%: doua conditii, juridica si financiara.'}


class Profiles(str):
    """A profile name that answers as each of several profiles, so the generator applies them all."""
    def __new__(cls, names: set[str]):
        value = super().__new__(cls, '+'.join(sorted(names)))
        value.names = names
        return value
    def __eq__(self, other): return other in self.names if isinstance(other, str) else NotImplemented
    def __ne__(self, other): return not self.__eq__(other)
    def __hash__(self): return str.__hash__(self)
    def startswith(self, prefix, *args): return any(n.startswith(prefix) for n in self.names)


def load_generator():
    source = (DATASET / 'generate_dataset.py').read_text()
    line = "case=CASES[(idx-1)%20] if idx<=40 else 'sanatos'"
    assert line in source, 'the generator changed: update generate-cases.py'
    module = types.ModuleType('generate_dataset')
    module.__file__ = str(DATASET / 'generate_dataset.py')
    exec(compile(source.replace(line, "case=PROFILES[idx] if idx in PROFILES else (CASES[(idx-1)%20] if idx<=40 else 'sanatos')"), module.__file__, 'exec'), module.__dict__)
    module.PROFILES = {idx: Profiles(names) for idx, names in CASES.items()}
    return module


def main() -> None:
    gen = load_generator()
    out = Path(tempfile.mkdtemp(prefix='creditdesk-cases-'))
    gen.OUT = out
    gen.TABLES = {k: [] for k in gen.SCHEMAS}
    sources = {r['simbol']: r for r in csv.DictReader(open(DATASET / 'companii_surse.csv'))}
    index = {e['dosar_id']: e for e in json.loads((DATASET / 'dataset/index_companii_50.json').read_text())}
    portfolio_file = ROOT / 'public/data/portfolio.json'
    portfolio = json.loads(portfolio_file.read_text())
    oracle_file = ROOT / 'tests/fixtures/oracle.json'
    oracle = json.loads(oracle_file.read_text())
    for idx, names in CASES.items():
        dossier = f'TEST-DOS-{idx:03}'
        entry = index[dossier]
        bundle = gen.generate_company(idx, sources[entry['simbol']])
        expected = gen.evaluate(bundle)
        expected['profil_test'] = '+'.join(sorted(names))
        expected['descriere_test'] = DESCRIPTIONS[idx]
        target = ROOT / 'public/documents' / dossier
        if target.exists(): shutil.rmtree(target)
        target.mkdir(parents=True)
        for doc in bundle['tables']['documente']:
            shutil.copyfile(out / doc['fisier'], target / Path(doc['fisier']).name)
        company = next(c for c in portfolio['companies'] if c['id'] == dossier)
        company['tables'] = bundle['tables']
        oracle = [expected if o['dosar_id'] == dossier else o for o in oracle]
        print(dossier, entry['denumire'], '·', expected['profil_test'], '→', ', '.join(s['tip_scenariu'] + ' ' + s['rezultat_asteptat'] for s in expected['scenarii']))
    portfolio_file.write_text(json.dumps(portfolio, ensure_ascii=False))
    oracle_file.write_text(json.dumps(oracle, ensure_ascii=False, indent=1))
    shutil.rmtree(out)


if __name__ == '__main__':
    sys.exit(main())
