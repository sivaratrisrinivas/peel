# Issue #9 pivot-cache fixture evidence

The environment gate uses `tests/fixtures/pivot-cache-only.xlsx`.

- Public source: [OOXML reference corpus pivot-table authoring case](https://loadfix.github.io/ooxml-reference-corpus/case/xlsx__pivot-table-authoring.html)
- Source download: `https://loadfix.github.io/ooxml-reference-corpus/fixtures/xlsx/pivot-table-authoring.xlsx`
- Source SHA-256: `f36825db2a85c67b64ce317ae2cec18edfe0eaabbd0089ebbe67f62470cc5693`
- Derived fixture SHA-256: `d4cb6df960f3d5780e89577db206d2068d75428851b0dafe2fd008af12d44167`

The derivation removes the visible `Data` worksheet, its workbook relationship,
and its content-type override. It leaves the pivot table, cache definition,
cache records, and populated `sharedItems` untouched. The remaining visible
`Report` worksheet therefore has no cache values, while the cache still has
four rows for deterministic cache-only reconstruction. The fixture reopens with
`openpyxl`, and the reproducible derivation is in
`scripts/derive_pivot_fixture.py`.
