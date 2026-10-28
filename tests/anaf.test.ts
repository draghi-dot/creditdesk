import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lookupAnaf, sameCompanyName } from '../server/engine/anaf.ts'

// Answers in the shape PlatitorTvaRest v9 returned when queried live (trimmed).
const answer = (status: number, body: unknown) => {
  globalThis.fetch = async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
const lookup = (cui: string) => lookupAnaf(cui, '2026-10-28', new AbortController().signal)

test('ANAF client maps a registered company and treats an unknown CUI as not found, not as an error', async () => {
  answer(200, {
    found: [{
      date_generale: { cui: 1350020, denumire: 'CONPET SA', adresa: 'JUD. PRAHOVA, MUN. PLOIEŞTI, STR. ANUL 1848, NR.1-3', stare_inregistrare: 'INREGISTRAT din data 29.11.1992',
        data_inregistrare: '1992-11-29', nrRegCom: 'J1991000006291', cod_CAEN: '4950', forma_juridica: 'SOCIETATE COMERCIALĂ PE ACŢIUNI', statusRO_e_Factura: false },
      inregistrare_scop_Tva: { scpTVA: true }, stare_inactiv: { statusInactivi: false },
    }],
    notFound: [],
  })
  const hit = await lookup('1350020')
  assert.equal(hit.error, null)
  assert.deepEqual([hit.found?.name, hit.found?.cui, hit.found?.tradeRegister, hit.found?.vatPayer, hit.found?.inactive], ['CONPET SA', 1350020, 'J1991000006291', true, false])

  // v9 answers 404 when none of the requested CUIs is registered.
  answer(404, { found: [], notFound: [99999999] })
  const miss = await lookup('99999999')
  assert.deepEqual([miss.found, miss.error], [null, null])

  answer(503, { message: 'Service Unavailable' })
  assert.equal((await lookup('1350020')).error, 'ANAF answered HTTP 503')
})

test('names that differ only in legal form or abbreviation are the same company; different companies are not', () => {
  // Dossier name → the name ANAF returned live for the same CUI.
  const same: [string, string][] = [
    ['AQUILA PART PROD COM', 'AQUILA PART PROD COM S.A.'], ['BITTNET SYSTEMS S.A. BUCURESTI', 'BITTNET SYSTEMS SA'],
    ['CASA DE BUCOVINA-CLUB DE MUNTE', 'CASA DE BUCOVINA - CLUB DE MUNTE SA'], ['COMCM SA CONSTANTA', 'COMCM SA'], ['IAR S.A. Brasov', 'IAR SA'],
    ['PREBET S.A. AIUD', 'PREBET AIUD SA'], ['S.N. NUCLEARELECTRICA S.A.', 'SOCIETATEA NATIONALA "NUCLEARELECTRICA" SA'],
    ['S.N.G.N. ROMGAZ S.A.', 'SOCIETATEA NATIONALA DE GAZE NATURALE " ROMGAZ " SA'],
    ['S.N.T.G.N. TRANSGAZ S.A.', 'SOCIETATEA NAŢIONALĂ DE TRANSPORT GAZE NATURALE TRANSGAZ SA'],
    ['S.P.E.E.H. HIDROELECTRICA S.A.', 'SOCIETATEA DE PRODUCERE A ENERGIEI ELECTRICE IN HIDROCENTRALE " HIDROELECTRICA" S.A.'],
    ['CONPET SA', 'CONPET SA'], ['ELECTROAPARATAJ S.A.', 'ELECTROAPARATAJ SA'], ['MEDLIFE S.A.', 'MED LIFE SA'],
  ]
  for (const [dossier, register] of same) assert.ok(sameCompanyName(dossier, register), dossier + ' = ' + register)
  for (const [a, b] of [['CONPET SA', 'OIL TERMINAL SA'], ['IAR SA', 'IAROM SA'], ['ROMGAZ SA', 'TRANSGAZ SA'], ['S.A.', 'CONPET SA']]) assert.ok(!sameCompanyName(a, b), a + ' ≠ ' + b)
})
