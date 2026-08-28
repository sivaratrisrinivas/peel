# Separate detection from repair safety

An Attack reports a Finding whenever its concealed-data mechanism is actually present, even when the content is legitimate or harmless; business legitimacy must not weaken deterministic detection. Clean fixtures therefore contain no concealed mechanism, while legitimate hidden-sheet and pivot fixtures are expected to produce Findings and prove that dependency analysis and approval policy prevent unsafe Repair.

For hidden worksheets, dependency analysis covers visible formulas, defined names, data validation, tables, charts, pivots, package relationships, macros, and external connections. An unreferenced hidden sheet may be proposed for deletion. Flatten-then-delete may be proposed only when every affected visible formula has a cached value; otherwise Peel refuses Repair.

For hidden rows and columns, clearing concealed values may be proposed only when they have no visible formula, defined-name, table, chart, pivot, or validation dependency. A dependency causes a Refusal in the MVP rather than broad formula rewriting.

The demo pivot fixture is accepted only when its package contains `pivotCacheDefinition`, `pivotCacheRecords`, and populated `sharedItems`, an Attack reconstructs at least one value absent from visible cells, the repaired workbook reopens successfully, and the same Attack then reports zero Findings.
