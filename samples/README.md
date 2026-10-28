# Test documents for "Add document"

Generated with the dataset's own generator (`raiffeisen_50_companii/generate_dataset.py`, seed 20261028), run into a scratch folder with two patches:

- **withheld/**: the generator computes these documents for every company but deliberately leaves them out of six dossiers. With that omission switched off, it writes them in the same format and with the figures the rest of each dossier was built from. The other 792 PDFs it produced were byte-identical to the dataset, so these documents are consistent with it.
- **corrected/**: the two "conflicting amount" dossiers print 110% of the requested amount on the application. These versions print the amount the bank recorded.

All data is synthetic demonstration data, like the rest of the dataset. The dataset itself was not modified.

| File | What it is | SHA-256 |
|---|---|---|
| `withheld/TEST-DOS-002_AEROSTAR-SA_cashflow.pdf` | AEROSTAR S.A.: cashflow (withheld from the dossier) | `2eb2c6bf26895b8b…` |
| `withheld/TEST-DOS-019_CONTED-SA_situatii_2024.pdf` | CONTED SA: situatii_2024 (withheld from the dossier) | `413a53766c90b91e…` |
| `withheld/TEST-DOS-019_CONTED-SA_situatii_2025.pdf` | CONTED SA: situatii_2025 (withheld from the dossier) | `5cb4cc64ab854325…` |
| `withheld/TEST-DOS-022_FARMACEUTICA-REMEDIA-SA_cashflow.pdf` | FARMACEUTICA REMEDIA S.A.: cashflow (withheld from the dossier) | `e336e26b04cd8b1a…` |
| `withheld/TEST-DOS-039_SNGN-ROMGAZ-SA_situatii_2024.pdf` | S.N.G.N. ROMGAZ S.A.: situatii_2024 (withheld from the dossier) | `15840c5b3bc869e3…` |
| `withheld/TEST-DOS-039_SNGN-ROMGAZ-SA_situatii_2025.pdf` | S.N.G.N. ROMGAZ S.A.: situatii_2025 (withheld from the dossier) | `65c10456fa5b1179…` |
| `corrected/TEST-DOS-018_CONPET-SA_cerere_finantare.pdf` | CONPET SA: financing application with the requested amount printed correctly | `03f3d05929d046a2…` |
| `corrected/TEST-DOS-038_SN-NUCLEARELECTRICA-SA_cerere_finantare.pdf` | S.N. NUCLEARELECTRICA S.A.: financing application with the requested amount printed correctly | `91ae24fec6f460d3…` |

The two "credit bureau access error" dossiers (TEST-DOS-013, TEST-DOS-033) have no sample: the generator never produced report data for them, so there is nothing to add.

Use: open the company, select the missing-document problem (or "Dossier documents" on the company page), choose **Add document** and pick the file. Then run a new assessment.
