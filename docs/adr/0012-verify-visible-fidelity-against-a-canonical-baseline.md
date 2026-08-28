# Verify visible fidelity against a canonical baseline

Before Repair, the engine records a Verification Baseline containing visible sheet order, visible cell values, formulas not explicitly approved for flattening, merged ranges, styles, and dimensions. After Repair it reruns every Attack, compares the candidate against that baseline, and reopens the workbook with both the Python parser and LibreOffice. Every observed change must follow from the approved Repair Plan. An unexplained change, parse failure, or reopen failure destroys the candidate artifact and blocks Disclosure.
