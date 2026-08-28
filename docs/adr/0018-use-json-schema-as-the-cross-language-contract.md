# Use JSON Schema as the cross-language contract

Versioned JSON Schema files under `schemas/` are the source of truth between the Python engine and TypeScript daemon. Every object sets `additionalProperties: false`, and both processes validate inputs and outputs at runtime. TypeScript types are generated where practical; independently maintained look-alike interfaces are not accepted as the contract.
