# Transform OOXML parts surgically

Repair uses targeted ZIP and XML transformations so unrelated workbook parts survive unchanged. `openpyxl` may assist inspection and reopen validation, but it does not save demo-critical repaired workbooks because a wholesale round trip may modify or discard unsupported pivot and extension structures. Package relationships and content types are updated explicitly and covered by fixture tests.
