from __future__ import annotations

import hashlib
from pathlib import Path
import zipfile

from scripts import daytona_engine
from scripts import environment_gate


ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "tests" / "fixtures" / "pivot-cache-only.xlsx"


def mutated_fixture(tmp_path: Path, name: str, mutate) -> Path:
    target = tmp_path / name
    with zipfile.ZipFile(FIXTURE) as original, zipfile.ZipFile(target, "w") as mutated:
        for info in original.infolist():
            payload = original.read(info.filename)
            payload = mutate(info.filename, payload)
            mutated.writestr(info, payload)
    return target


def visible_source_mutation(member: str, payload: bytes) -> bytes:
    if member == "xl/workbook.xml":
        return (
            payload.decode()
            .replace(
                'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
                'xmlns:x="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
            )
            .replace("r:id=", "x:id=")
            .replace('name="Report"', 'name="Data"')
            .encode()
        )
    if member == "xl/worksheets/sheet2.xml":
        return (
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
            '<row r="1"><c r="A1" t="str"><v>North</v></c><c r="B1" t="str"><v>Q1</v></c><c r="C1"><v>10</v></c></row>'
            '<row r="2"><c r="A2" t="str"><v>North</v></c><c r="B2" t="str"><v>Q2</v></c><c r="C2"><v>12</v></c></row>'
            '<row r="3"><c r="A3" t="str"><v>South</v></c><c r="B3" t="str"><v>Q1</v></c><c r="C3"><v>8</v></c></row>'
            '<row r="4"><c r="A4" t="str"><v>South</v></c><c r="B4" t="str"><v>Q2</v></c><c r="C4"><v>13</v></c></row>'
            "</sheetData></worksheet>"
        ).encode()
    return payload


def missing_records_mutation(member: str, payload: bytes) -> bytes:
    if member == "xl/pivotCache/_rels/pivotCacheDefinition1.xml.rels":
        return b'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'
    return payload


def mixed_field_mutation(member: str, payload: bytes) -> bytes:
    if member == "xl/pivotCache/pivotCacheDefinition1.xml":
        return payload.decode().replace(
            '<cacheFields count="3"><cacheField name="Region"><sharedItems count="2" containsString="1"><s v="North"/><s v="South"/></sharedItems></cacheField><cacheField name="Quarter"><sharedItems count="2" containsString="1"><s v="Q1"/><s v="Q2"/></sharedItems></cacheField><cacheField name="Sales"><sharedItems count="0" containsInteger="1" containsNumber="1" containsSemiMixedTypes="0" containsString="0" minValue="8" maxValue="13"/></cacheField></cacheFields>',
            '<cacheFields count="3"><cacheField name="Sales"><sharedItems count="0"/></cacheField><cacheField name="Region"><sharedItems count="2"><s v="North"/><s v="South"/></sharedItems></cacheField><cacheField name="Quarter"><sharedItems count="2"><s v="Q1"/><s v="Q2"/></sharedItems></cacheField></cacheFields>',
        ).encode()
    if member == "xl/pivotCache/pivotCacheRecords1.xml":
        return (
            '<pivotCacheRecords count="4" xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            '<r><n v="10"/><x v="0"/><x v="0"/></r><r><n v="12"/><x v="0"/><x v="1"/></r>'
            '<r><n v="8"/><x v="1"/><x v="0"/></r><r><n v="13"/><x v="1"/><x v="1"/></r></pivotCacheRecords>'
        ).encode()
    return payload


def test_production_engine_reconstructs_repairs_and_verifies_pivot_cache(tmp_path: Path) -> None:
    source = tmp_path / "pivot-cache-only.xlsx"
    source.write_bytes(FIXTURE.read_bytes())
    payload = source.read_bytes()
    digest = hashlib.sha256(payload).hexdigest()

    scan = daytona_engine._scan_package(source, digest)
    assert scan["findings"] == [
        {"mechanism": "pivot_cache", "location": "xl/pivotCache/pivotCacheRecords1.xml", "count": 4}
    ]
    plan = scan["repair_plan"]
    assert plan["status"] == "eligible"
    assert plan["actions"][0]["kind"] == "clear_pivot_cache_values"
    assert plan["changed_members"] == [
        "xl/pivotCache/pivotCacheDefinition1.xml",
        "xl/pivotCache/pivotCacheRecords1.xml",
    ]

    repair = daytona_engine._repair_package(source, digest, plan)
    candidate = Path(daytona_engine.REPAIR_OUTPUT_PATH)
    candidate_digest = hashlib.sha256(candidate.read_bytes()).hexdigest()
    assert repair["status"] == "repaired"
    assert repair["artifact_sha256"] == candidate_digest

    with zipfile.ZipFile(source) as original, zipfile.ZipFile(candidate) as repaired:
        original_members = set(original.namelist())
        candidate_members = set(repaired.namelist())
        assert candidate_members == original_members
        assert repaired.read("xl/pivotTables/pivotTable1.xml") == original.read("xl/pivotTables/pivotTable1.xml")
        definition = repaired.read("xl/pivotCache/pivotCacheDefinition1.xml").decode("utf-8")
        records = repaired.read("xl/pivotCache/pivotCacheRecords1.xml").decode("utf-8")
        assert 'recordCount="0"' in definition
        assert not any(f"<{tag} " in definition for tag in ("s", "n", "d", "b", "e", "m"))
        assert 'count="0"' in records
        assert "<r>" not in records
        for member in original_members - set(plan["changed_members"]):
            assert repaired.read(member) == original.read(member)

    verified = daytona_engine._verify_package(candidate, candidate_digest, digest, source, plan)
    assert verified["status"] == "verified"
    assert verified["remaining_findings"] == []
    assert verified["relationships_valid"] is True
    assert verified["content_types_valid"] is True
    assert verified["reopened_with"]
    assert verified["unexplained_changes"] == []


def test_production_engine_refuses_external_pivot_cache_sources(tmp_path: Path) -> None:
    source = tmp_path / "external-pivot.xlsx"
    with zipfile.ZipFile(FIXTURE) as original, zipfile.ZipFile(source, "w") as mutated:
        for info in original.infolist():
            payload = original.read(info.filename)
            if info.filename == "xl/pivotCache/pivotCacheDefinition1.xml":
                payload = payload.replace(b'type="worksheet"', b'type="external"')
            mutated.writestr(info, payload)

    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    scan = daytona_engine._scan_package(source, digest)
    assert scan["findings"] == [
        {"mechanism": "pivot_cache", "location": "xl/pivotCache/pivotCacheRecords1.xml", "count": 4}
    ]
    assert scan["repair_plan"]["status"] == "refused"
    assert "external" in " ".join(scan["repair_plan"]["refusal_reasons"]).lower()


def test_production_engine_ignores_cache_values_that_are_visible_with_prefixed_relationships(tmp_path: Path) -> None:
    source = mutated_fixture(tmp_path, "visible-pivot.xlsx", visible_source_mutation)
    digest = hashlib.sha256(source.read_bytes()).hexdigest()

    scan = daytona_engine._scan_package(source, digest)

    assert scan["findings"] == []
    assert "repair_plan" not in scan


def test_production_engine_preserves_empty_shared_item_field_alignment(tmp_path: Path) -> None:
    source = mutated_fixture(tmp_path, "mixed-fields.xlsx", mixed_field_mutation)
    digest = hashlib.sha256(source.read_bytes()).hexdigest()

    scan = daytona_engine._scan_package(source, digest)

    assert scan["findings"] == [
        {"mechanism": "pivot_cache", "location": "xl/pivotCache/pivotCacheRecords1.xml", "count": 4}
    ]
    inspection = daytona_engine._inspect_package(source, digest)
    assert inspection["pivot_caches"][0]["rows"][0] == ["10", "North", "Q1"]


def test_production_engine_uses_definition_location_when_records_relationship_is_missing(tmp_path: Path) -> None:
    source = mutated_fixture(tmp_path, "missing-records.xlsx", missing_records_mutation)
    digest = hashlib.sha256(source.read_bytes()).hexdigest()

    scan = daytona_engine._scan_package(source, digest)

    assert scan["findings"] == [
        {"mechanism": "pivot_cache", "location": "xl/pivotCache/pivotCacheDefinition1.xml", "count": 1}
    ]
    assert scan["repair_plan"]["status"] == "refused"


def test_environment_gate_does_not_treat_visible_cache_rows_as_cache_only(tmp_path: Path) -> None:
    fixture_root = tmp_path / "tests" / "fixtures"
    fixture_root.mkdir(parents=True)
    visible = mutated_fixture(tmp_path, "visible-pivot.xlsx", visible_source_mutation)
    (fixture_root / visible.name).write_bytes(visible.read_bytes())

    gate = environment_gate._probe_pivot_fixture(tmp_path)

    assert gate["status"] == "cut"
    assert gate["evidence"]["required_parts_found"] is True
    assert gate["evidence"]["cache_only_value_found"] is False
