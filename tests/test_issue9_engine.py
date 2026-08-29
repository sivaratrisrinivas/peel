from __future__ import annotations

import hashlib
from pathlib import Path
import zipfile

from scripts import daytona_engine


ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "tests" / "fixtures" / "pivot-cache-only.xlsx"


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
