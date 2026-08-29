from __future__ import annotations

from collections.abc import Mapping
import hashlib
import io
import zipfile
from pathlib import Path

from scripts import daytona_engine


def _package(
    worksheet: str,
    *,
    output: Path,
    workbook: str | None = None,
    extras: Mapping[str, str | bytes] | None = None,
) -> Path:
    workbook_xml = workbook or (
        '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<sheets><sheet name="Visible" sheetId="1" r:id="rId1"/></sheets></workbook>'
    )
    files: dict[str, str | bytes] = {
        "[Content_Types].xml": (
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            "</Types>"
        ),
        "_rels/.rels": (
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rIdRoot" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
            "</Relationships>"
        ),
        "xl/workbook.xml": workbook_xml,
        "xl/_rels/workbook.xml.rels": (
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'
        ),
        "xl/worksheets/sheet1.xml": worksheet,
    }
    files.update(extras or {})
    with zipfile.ZipFile(output, "w") as package:
        for name, payload in files.items():
            package.writestr(name, payload)
    return output


def _hidden_values() -> str:
    return (
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        '<cols><col min="3" max="3" hidden="true"/></cols><sheetData>'
        '<row r="1"><c r="A1" t="inlineStr"><is><t>visible</t></is></c></row>'
        '<row r="2" hidden="1"><c r="A2" t="inlineStr"><is><t>legitimate concealment</t></is></c></row>'
        '<row r="3"><c r="A3"><v>visible</v></c><c r="C3"><v>123</v></c></row>'
        "</sheetData></worksheet>"
    )


def test_issue8_engine_detects_and_repairs_hidden_row_and_column_values(tmp_path: Path) -> None:
    source = _package(_hidden_values(), output=tmp_path / "source.xlsx")
    payload = source.read_bytes()
    digest = hashlib.sha256(payload).hexdigest()

    scan = daytona_engine._scan_package(source, digest)
    assert scan["findings"] == [
        {"mechanism": "hidden_row_or_column", "location": "xl/worksheets", "count": 2}
    ]
    plan = scan["repair_plan"]
    assert plan["status"] == "eligible"
    assert plan["actions"] == [
        {
            "kind": "clear_hidden_cell_values",
            "worksheet": "Visible",
            "target_member": "xl/worksheets/sheet1.xml",
            "cell_references": ["A2", "C3"],
            "changed_members": ["xl/worksheets/sheet1.xml"],
            "capability_losses": plan["actions"][0]["capability_losses"],
        }
    ]

    repair = daytona_engine._repair_package(source, digest, plan)
    candidate = Path(daytona_engine.REPAIR_OUTPUT_PATH)
    candidate_digest = hashlib.sha256(candidate.read_bytes()).hexdigest()
    assert repair["status"] == "repaired"
    assert repair["changed_members"] == ["xl/worksheets/sheet1.xml"]
    assert repair["artifact_sha256"] == candidate_digest
    with zipfile.ZipFile(source) as original, zipfile.ZipFile(candidate) as repaired:
        assert repaired.read("xl/worksheets/sheet1.xml") != original.read("xl/worksheets/sheet1.xml")
        assert repaired.read("xl/workbook.xml") == original.read("xl/workbook.xml")
        assert repaired.read("xl/_rels/workbook.xml.rels") == original.read("xl/_rels/workbook.xml.rels")
    verified = daytona_engine._verify_package(candidate, candidate_digest, digest, source, plan)
    assert verified["status"] == "verified"
    assert verified["artifact_unchanged"] is True
    assert verified["remaining_findings"] == []


def test_issue8_engine_refuses_every_declared_dependency(tmp_path: Path) -> None:
    cases: dict[str, tuple[str, str | None, Mapping[str, str | bytes], str]] = {
        "formula": (
            '<worksheet><sheetData><row r="2" hidden="1"><c r="A2"><v>1</v></c></row>'
            '<row r="4"><c r="A4"><f>A2</f></c></row></sheetData></worksheet>',
            None,
            {},
            "visible_formulas",
        ),
        "formula_column_range": (
            '<worksheet><sheetData><row r="2" hidden="1"><c r="A2"><v>1</v></c></row>'
            '<row r="4"><c r="A4"><f>SUM(A:A)</f></c></row></sheetData></worksheet>',
            None,
            {},
            "visible_formulas",
        ),
        "name": (
            '<worksheet><sheetData><row r="2" hidden="1"><c r="A2"><v>1</v></c></row></sheetData></worksheet>',
            '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><definedNames><definedName name="Secret">Visible!A2</definedName></definedNames>'
            '<sheets><sheet name="Visible" sheetId="1" r:id="rId1"/></sheets></workbook>',
            {},
            "defined_names",
        ),
        "sheet_local_name": (
            '<worksheet><sheetData><row r="2" hidden="1"><c r="A2"><v>1</v></c></row></sheetData></worksheet>',
            '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><definedNames><definedName name="Secret" localSheetId="0">$A$2</definedName></definedNames>'
            '<sheets><sheet name="Visible" sheetId="1" r:id="rId1"/></sheets></workbook>',
            {},
            "defined_names",
        ),
        "validation": (
            '<worksheet><sheetData><row r="2" hidden="1"><c r="A2"><v>1</v></c></row></sheetData>'
            '<dataValidations><dataValidation sqref="A2"/></dataValidations></worksheet>',
            None,
            {},
            "data_validation",
        ),
        "table": (
            '<worksheet><sheetData><row r="2" hidden="1"><c r="A2"><v>1</v></c></row></sheetData></worksheet>',
            None,
            {
                "xl/tables/table1.xml": '<table ref="A2:A2"/>',
                "xl/worksheets/_rels/sheet1.xml.rels": (
                    '<Relationships><Relationship Id="table" Type="table" Target="../tables/table1.xml"/></Relationships>'
                ),
            },
            "tables",
        ),
        "chart": (
            '<worksheet><sheetData><row r="2" hidden="1"><c r="A2"><v>1</v></c></row></sheetData></worksheet>',
            None,
            {
                "xl/charts/chart1.xml": "<chart><f>Visible!A2</f></chart>",
                "xl/worksheets/_rels/sheet1.xml.rels": (
                    '<Relationships><Relationship Id="chart" Type="chart" Target="../charts/chart1.xml"/></Relationships>'
                ),
            },
            "charts",
        ),
        "pivot": (
            '<worksheet><sheetData><row r="2" hidden="1"><c r="A2"><v>1</v></c></row></sheetData></worksheet>',
            None,
            {
                "xl/pivotTables/pivotTable1.xml": '<pivotTableDefinition><worksheetSource ref="A2:A2"/></pivotTableDefinition>',
                "xl/worksheets/_rels/sheet1.xml.rels": (
                    '<Relationships><Relationship Id="pivot" Type="pivotTable" Target="../pivotTables/pivotTable1.xml"/></Relationships>'
                ),
            },
            "pivots",
        ),
    }
    for index, (worksheet, workbook, extras, dependency) in enumerate(cases.values()):
        source = _package(worksheet, output=tmp_path / f"dependency-{index}.xlsx", workbook=workbook, extras=extras)
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        result = daytona_engine._scan_package(source, digest)
        assert result["repair_plan"]["status"] == "refused"
        assert result["repair_plan"]["dependency_analysis"][dependency]
        assert result["repair_plan"]["refusal_reasons"]


def test_issue8_engine_resolves_middle_sheets_in_3d_formula_ranges(tmp_path: Path) -> None:
    workbook = (
        '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
        '<sheet name="Sheet1" sheetId="1" r:id="rId1"/>'
        '<sheet name="Sheet2" sheetId="2" r:id="rId2"/>'
        '<sheet name="Sheet3" sheetId="3" r:id="rId3"/>'
        '</sheets></workbook>'
    )
    extras = {
        "xl/_rels/workbook.xml.rels": (
            '<Relationships>'
            '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/>'
            '<Relationship Id="rId2" Target="worksheets/sheet2.xml"/>'
            '<Relationship Id="rId3" Target="worksheets/sheet3.xml"/>'
            '</Relationships>'
        ),
        "xl/worksheets/sheet2.xml": '<worksheet><sheetData><row r="2" hidden="1"><c r="A2"><v>secret</v></c></row></sheetData></worksheet>',
        "xl/worksheets/sheet3.xml": '<worksheet><sheetData/></worksheet>',
    }
    for index, formula in enumerate(("SUM(Sheet1:Sheet3!A2)", "SUM('Sheet1:Sheet3'!A2)")):
        source = _package(
            f'<worksheet><sheetData><row r="1"><c r="A1"><f>{formula}</f></c></row></sheetData></worksheet>',
            output=tmp_path / f"three-dimensional-{index}.xlsx",
            workbook=workbook,
            extras=extras,
        )
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        result = daytona_engine._scan_package(source, digest)
        assert result["repair_plan"]["status"] == "refused"
        assert "xl/worksheets/sheet1.xml" in result["repair_plan"]["dependency_analysis"]["visible_formulas"]


def test_issue8_engine_resolves_ordinary_unquoted_cross_sheet_references(tmp_path: Path) -> None:
    source = _package(
        '<worksheet><sheetData><row r="1"><c r="A1"><f>SUM(Sheet2!A2)</f></c></row></sheetData></worksheet>',
        output=tmp_path / "ordinary-cross-sheet.xlsx",
        workbook=(
            '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
            '<sheet name="Sheet1" sheetId="1" r:id="rId1"/>'
            '<sheet name="Sheet2" sheetId="2" r:id="rId2"/>'
            '<sheet name="Sheet3" sheetId="3" r:id="rId3"/>'
            '</sheets></workbook>'
        ),
        extras={
            "xl/_rels/workbook.xml.rels": (
                '<Relationships>'
                '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/>'
                '<Relationship Id="rId2" Target="worksheets/sheet2.xml"/>'
                '<Relationship Id="rId3" Target="worksheets/sheet3.xml"/>'
                '</Relationships>'
            ),
            "xl/worksheets/sheet2.xml": '<worksheet><sheetData><row r="2" hidden="1"><c r="A2"><v>secret</v></c></row></sheetData></worksheet>',
            "xl/worksheets/sheet3.xml": '<worksheet><sheetData/></worksheet>',
        },
    )
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    result = daytona_engine._scan_package(source, digest)
    assert result["repair_plan"]["status"] == "refused"
    assert "xl/worksheets/sheet1.xml" in result["repair_plan"]["dependency_analysis"]["visible_formulas"]


def test_issue8_engine_ignores_3d_sheet_prefix_inside_longer_name(tmp_path: Path) -> None:
    source = _package(
        '<worksheet><sheetData><row r="2" hidden="1"><c r="A2"><v>secret</v></c></row></sheetData></worksheet>',
        output=tmp_path / "3d-prefix-collision.xlsx",
        workbook=(
            '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
            '<sheet name="Jan" sheetId="1" r:id="rId1"/>'
            '<sheet name="NotJan" sheetId="2" r:id="rId2"/>'
            '<sheet name="Mar" sheetId="3" r:id="rId3"/>'
            '</sheets></workbook>'
        ),
        extras={
            "xl/_rels/workbook.xml.rels": (
                '<Relationships>'
                '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/>'
                '<Relationship Id="rId2" Target="worksheets/sheet2.xml"/>'
                '<Relationship Id="rId3" Target="worksheets/sheet3.xml"/>'
                '</Relationships>'
            ),
            "xl/worksheets/sheet2.xml": '<worksheet><sheetData><row r="1"><c r="A1"><f>SUM(NotJan:Mar!A2)</f></c></row></sheetData></worksheet>',
            "xl/worksheets/sheet3.xml": '<worksheet><sheetData/></worksheet>',
        },
    )
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    result = daytona_engine._scan_package(source, digest)
    assert result["repair_plan"]["status"] == "eligible"
    assert result["repair_plan"]["dependency_analysis"]["visible_formulas"] == []


def test_issue8_engine_resolves_3d_whole_ranges_for_first_middle_and_last_sheets(tmp_path: Path) -> None:
    workbook = (
        '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
        '<sheet name="Sheet1" sheetId="1" r:id="rId1"/>'
        '<sheet name="Sheet2" sheetId="2" r:id="rId2"/>'
        '<sheet name="Sheet3" sheetId="3" r:id="rId3"/>'
        '</sheets></workbook>'
    )
    relationships = (
        '<Relationships>'
        '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/>'
        '<Relationship Id="rId2" Target="worksheets/sheet2.xml"/>'
        '<Relationship Id="rId3" Target="worksheets/sheet3.xml"/>'
        '</Relationships>'
    )
    for formula_index, formula in enumerate((
        "SUM(Sheet1:Sheet3!A:A)",
        "SUM('Sheet1:Sheet3'!A:A)",
        "SUM(Sheet1:Sheet3!2:2)",
        "SUM('Sheet1:Sheet3'!2:2)",
    )):
        for concealed_sheet in (1, 2, 3):
            formula_sheet = 3 if concealed_sheet == 1 else 1
            worksheets = {}
            for sheet_number in (1, 2, 3):
                rows = []
                if sheet_number == formula_sheet:
                    rows.append(f'<row r="1"><c r="A1"><f>{formula}</f></c></row>')
                if sheet_number == concealed_sheet:
                    rows.append('<row r="2" hidden="1"><c r="A2"><v>secret</v></c></row>')
                worksheets[f"xl/worksheets/sheet{sheet_number}.xml"] = f'<worksheet><sheetData>{"".join(rows)}</sheetData></worksheet>'
            source = _package(
                worksheets["xl/worksheets/sheet1.xml"],
                output=tmp_path / f"three-dimensional-whole-{formula_index}-{concealed_sheet}.xlsx",
                workbook=workbook,
                extras={
                    "xl/_rels/workbook.xml.rels": relationships,
                    "xl/worksheets/sheet2.xml": worksheets["xl/worksheets/sheet2.xml"],
                    "xl/worksheets/sheet3.xml": worksheets["xl/worksheets/sheet3.xml"],
                },
            )
            digest = hashlib.sha256(source.read_bytes()).hexdigest()
            result = daytona_engine._scan_package(source, digest)
            assert result["repair_plan"]["status"] == "refused"
            assert f"xl/worksheets/sheet{formula_sheet}.xml" in result["repair_plan"]["dependency_analysis"]["visible_formulas"]


def test_issue8_engine_resolves_unicode_3d_whole_ranges(tmp_path: Path) -> None:
    workbook = (
        '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
        '<sheet name="一月" sheetId="1" r:id="rId1"/>'
        '<sheet name="二月" sheetId="2" r:id="rId2"/>'
        '<sheet name="三月" sheetId="3" r:id="rId3"/>'
        '</sheets></workbook>'
    )
    extras = {
        "xl/_rels/workbook.xml.rels": (
            '<Relationships>'
            '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/>'
            '<Relationship Id="rId2" Target="worksheets/sheet2.xml"/>'
            '<Relationship Id="rId3" Target="worksheets/sheet3.xml"/>'
            '</Relationships>'
        ),
        "xl/worksheets/sheet2.xml": '<worksheet><sheetData><row r="2" hidden="1"><c r="A2"><v>secret</v></c></row></sheetData></worksheet>',
        "xl/worksheets/sheet3.xml": '<worksheet><sheetData/></worksheet>',
    }
    for index, formula in enumerate(("SUM(一月:三月!A:A)", "SUM(一月:三月!2:2)")):
        source = _package(
            f'<worksheet><sheetData><row r="1"><c r="A1"><f>{formula}</f></c></row></sheetData></worksheet>',
            output=tmp_path / f"unicode-three-dimensional-{index}.xlsx",
            workbook=workbook,
            extras=extras,
        )
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        result = daytona_engine._scan_package(source, digest)
        assert result["repair_plan"]["status"] == "refused"
        assert "xl/worksheets/sheet1.xml" in result["repair_plan"]["dependency_analysis"]["visible_formulas"]


def test_issue8_engine_refuses_duplicate_attributes_and_out_of_grid_cells(tmp_path: Path) -> None:
    duplicate = _package(
        '<worksheet a="1" a="2"><sheetData/></worksheet>',
        output=tmp_path / "duplicate-attributes.xlsx",
    )
    duplicate_digest = hashlib.sha256(duplicate.read_bytes()).hexdigest()
    duplicate_result = daytona_engine._scan_package(duplicate, duplicate_digest)
    assert duplicate_result["status"] == "refused"
    assert duplicate_result["refusal_code"] == "unsupported_content"

    for index, reference in enumerate(("XFE1", "A1048577")):
        source = _package(
            f'<worksheet><sheetData><row r="1" hidden="1"><c r="{reference}"><v>secret</v></c></row></sheetData></worksheet>',
            output=tmp_path / f"out-of-grid-{index}.xlsx",
        )
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        result = daytona_engine._scan_package(source, digest)
        assert result["repair_plan"]["status"] == "refused"
        assert "without an exact cell reference" in " ".join(result["repair_plan"]["refusal_reasons"])


def test_issue8_engine_refuses_malformed_workbook(tmp_path: Path) -> None:
    source = _package("<worksheet><sheetData/></worksheet>trailing", output=tmp_path / "malformed.xlsx")
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    result = daytona_engine._scan_package(source, digest)
    assert result["status"] == "refused"
    assert result["refusal_code"] == "unsupported_content"


def test_issue8_engine_refuses_unprovable_value_storage(tmp_path: Path) -> None:
    missing_reference = _package(
        '<worksheet><sheetData><row r="2" hidden="1"><c t="inlineStr"><is><t>secret</t></is></c></row></sheetData></worksheet>',
        output=tmp_path / "missing-reference.xlsx",
    )
    missing_digest = hashlib.sha256(missing_reference.read_bytes()).hexdigest()
    missing_result = daytona_engine._scan_package(missing_reference, missing_digest)
    assert missing_result["findings"] == [
        {"mechanism": "hidden_row_or_column", "location": "xl/worksheets", "count": 1}
    ]
    assert missing_result["repair_plan"]["status"] == "refused"
    assert "without an exact cell reference" in " ".join(missing_result["repair_plan"]["refusal_reasons"])

    shared_string = _package(
        '<worksheet><sheetData><row r="2" hidden="1"><c r="A2" t="s"><v>0</v></c></row></sheetData></worksheet>',
        output=tmp_path / "shared-string.xlsx",
        extras={"xl/sharedStrings.xml": "<sst><si><t>secret</t></si></sst>"},
    )
    shared_digest = hashlib.sha256(shared_string.read_bytes()).hexdigest()
    shared_result = daytona_engine._scan_package(shared_string, shared_digest)
    assert shared_result["repair_plan"]["status"] == "refused"
    assert "shared-string value" in " ".join(shared_result["repair_plan"]["refusal_reasons"])
