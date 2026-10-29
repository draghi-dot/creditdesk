#!/usr/bin/env python3
"""Ten credit clients: companies whose financing was approved and drawn.

Uses the dataset's own generator (../raiffeisen_50_companii/generate_dataset.py)
with its healthy profile, so each client has the same 16 original documents and
tables as the 50 applications. Identities are real listed companies whose CUI
and name were confirmed in the ANAF register; financial data is generated like
the rest of the dataset. Writes the PDFs to public/documents/<dossier>/, the
clients to public/data/clients.json and the generator's expected results to
tests/fixtures/clients-oracle.json (tests only). Clients already generated are
kept as they are (their documents and fingerprints do not change); only new
ones are generated.

    python3 scripts/generate-clients.py
"""
from __future__ import annotations
import importlib.util, json, shutil, sys, tempfile
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATASET = ROOT.parent / 'raiffeisen_50_companii'

# Real listed companies, not among the 50 applications; CUI and register name checked in ANAF on 28 Oct 2026.
CLIENTS = [
    ('TEL', 'C.N.T.E.E. TRANSELECTRICA S.A.', '13328043', 'transport energie electrica', '3512', 'Bucuresti', 'Electricity transmission'),
    ('TTS', 'TRANSPORT TRADE SERVICES S.A.', '9089452', 'logistica', '5229', 'Bucuresti', 'Freight & logistics'),
    ('CEON', 'CEMACON S.A.', '677858', 'materiale constructii', '2332', 'Recea, Salaj', 'Building materials'),
    ('SCD', 'ZENTIVA S.A.', '336206', 'farmaceutice', '2120', 'Bucuresti', 'Pharmaceuticals'),
    ('TBM', 'TURBOMECANICA S.A.', '3156315', 'industria aeronautica', '3030', 'Bucuresti', 'Aerospace'),
    ('CRC', 'CHIMCOMPLEX S.A. BORZESTI', '960322', 'industrie chimica', '2013', 'Onesti', 'Chemicals'),
    ('RORX', 'ROMAERO S.A.', '1576401', 'industria aeronautica', '3030', 'Bucuresti', 'Aerospace maintenance'),
    ('DN', 'DN AGRAR GROUP S.A.', '24020501', 'agricultura', '0141', 'Alba Iulia', 'Dairy & agriculture'),
    ('NRF', 'NOROFERT S.A.', '12972762', 'inputuri agricole', '2015', 'Bucuresti', 'Agricultural inputs'),
    ('HAI', 'HOLDE AGRI INVEST S.A.', '39549730', 'agricultura', '0111', 'Bucuresti', 'Crop farming'),
    # Not listed on the exchange; much in the news, which makes it the client to show monitoring with. CUI checked in ANAF on 28 Oct 2026.
    ('TAROM', 'COMPANIA NATIONALA DE TRANSPORTURI AERIENE ROMANE TAROM SA', '477647', 'transport aerian', '5110', 'Otopeni', 'Air transport'),
]
UNLISTED = {'TAROM'}
FIRST = 51
MANAGERS = ['Elena Dumitrescu', 'Andrei Popa', 'Cristina Dobre']
# Names each company goes by in the news (its BVB symbol alone is too ambiguous to match on).
TERMS = {'TEL': ['Transelectrica'], 'TTS': ['Transport Trade Services'], 'CEON': ['Cemacon'], 'SCD': ['Zentiva'], 'TBM': ['Turbomecanica'],
         'CRC': ['Chimcomplex'], 'RORX': ['Romaero'], 'DN': ['DN Agrar'], 'NRF': ['Norofert'], 'HAI': ['Holde Agri', 'Holde'], 'TAROM': ['Tarom']}


def month_add(day: date, months: int) -> date:
    y, m = divmod(day.month - 1 + months, 12)
    return date(day.year + y, m + 1, min(day.day, 28))


def main() -> None:
    spec = importlib.util.spec_from_file_location('generate_dataset', DATASET / 'generate_dataset.py')
    gen = importlib.util.module_from_spec(spec); spec.loader.exec_module(gen)
    out = Path(tempfile.mkdtemp(prefix='creditdesk-clients-'))
    gen.OUT = out
    gen.TABLES = {k: [] for k in gen.SCHEMAS}
    policy = json.loads((ROOT / 'public/data/portfolio.json').read_text())['policy']
    clients, oracle = [], []
    existing_file = ROOT / 'public/data/clients.json'
    existing = {c['id']: c for c in json.loads(existing_file.read_text())['clients']} if existing_file.exists() else {}
    existing_oracle = {o['dosar_id']: o for o in json.loads((ROOT / 'tests/fixtures/clients-oracle.json').read_text())} if (ROOT / 'tests/fixtures/clients-oracle.json').exists() else {}
    for n, (symbol, name, cui, sector_ro, caen, city, sector) in enumerate(CLIENTS):
        idx = FIRST + n
        dossier = f'TEST-DOS-{idx:03}'
        if dossier in existing and dossier in existing_oracle and (ROOT / 'public/documents' / dossier).exists():
            clients.append(existing[dossier]); oracle.append(existing_oracle[dossier]); continue
        bundle = gen.generate_company(idx, {'simbol': symbol, 'denumire': name, 'cui': cui, 'sector_demo': sector_ro, 'caen_ipoteza': caen, 'oras_demo': city})
        assert bundle['case'] == 'sanatos', bundle['case']
        expected = gen.evaluate(bundle)
        assert expected['scenarii'][0]['rezultat_asteptat'] == 'ELIGIBIL', (symbol, expected['scenarii'][0])
        tables = bundle['tables']
        target = ROOT / 'public/documents' / dossier
        if target.exists(): shutil.rmtree(target)
        target.mkdir(parents=True)
        for doc in tables['documente']:
            shutil.copyfile(out / doc['fisier'], target / Path(doc['fisier']).name)
        request = tables['solicitari'][0]
        approved = date(2025, 11, 3) + timedelta(days=29 * n)
        start = approved + timedelta(days=14)
        drawn_share = [0.62, 0.81, 0.74, 0.9, 0.55, 0.68, 0.77, 0.85, 0.6, 0.71, 0.66][n]
        collateral = [g for g in tables['garantii'] if g['garantie_id'] in tables['scenarii'][0]['garantie_ids']]
        clients.append({
            'id': dossier, 'symbol': symbol, 'name': name, 'cui': cui, 'sector': sector, 'city': city.split(',')[0], 'tables': tables, 'monitorTerms': TERMS[symbol], **({'listed': False} if symbol in UNLISTED else {}),
            'creditLine': {
                'facilityId': f'CL-2026-{idx:03}', 'product': 'Investment loan', 'limit': request['suma_solicitata'], 'currency': 'RON',
                'drawn': round(request['suma_solicitata'] * drawn_share, 2), 'rate': request['dobanda_anuala_ipoteza'],
                'termMonths': request['durata_luni'], 'approvedAt': approved.isoformat(), 'approvedBy': 'Credit committee',
                'startDate': start.isoformat(), 'maturity': month_add(start, request['durata_luni']).isoformat(),
                'nextReview': month_add(start, 12).isoformat(), 'relationshipManager': MANAGERS[n % 3],
                'covenants': {'dscrMin': policy['dscr_min'], 'leverageMax': policy['datorie_ebitda_max'], 'liquidityMin': policy['lichiditate_min']},
                'collateral': [{'type': g['tip'], 'acceptedValue': g['valoare_acceptata_banca']} for g in collateral],
            },
        })
        oracle.append(expected)
    (ROOT / 'public/data/clients.json').write_text(json.dumps({'clients': clients}, ensure_ascii=False))
    (ROOT / 'tests/fixtures/clients-oracle.json').write_text(json.dumps(oracle, ensure_ascii=False, indent=1))
    shutil.rmtree(out)
    print(f'{len(clients)} credit clients: ' + ', '.join(c['symbol'] for c in clients))


if __name__ == '__main__':
    sys.exit(main())
