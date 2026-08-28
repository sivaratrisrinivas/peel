# Isolate and minimize run artifacts

Each Run will keep the original artifact immutable and place extraction and repaired artifacts in an isolated per-Run directory inside one persistent Daytona sandbox. Runs execute serially. Sign-off may retain the repaired artifact, hashes, Repair Plan, approvals, and Verification report, but Reveal Samples and temporary extraction files are deleted during cleanup and generated artifacts are never committed. If cleanup cannot be proven, the sandbox is destroyed and recreated before another artifact is processed.
