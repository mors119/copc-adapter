# COPC Cesium Viewer Project Rules

## Project Mission

This project builds a reusable COPC (Cloud Optimized Point Cloud) visualization library for CesiumJS.

The final goal is:

"Render large-scale Point Cloud data directly in CesiumJS from COPC files without preprocessing or conversion."

The library should support:

- Direct COPC file loading
- HTTP Range Request streaming
- Hierarchical node traversal
- Level of Detail (LoD) based loading
- Point decoding
- Coordinate transformation
- Cesium rendering
- Reusable public APIs

The long-term architecture should allow replacing the current TypeScript decoder with a Rust + WebAssembly implementation.

---

# Development Philosophy

This project is developed with AI assistance.

AI-generated code must follow existing architecture and must not introduce shortcuts.

Before implementing any feature:

1. Understand the project goal.
2. Read related documentation.
3. Identify the correct layer.
4. Create or update tests.
5. Implement.
6. Verify architecture consistency.

Do not optimize prematurely.

Prefer:

- readability
- maintainability
- modularity
- testability

over clever implementations.

---

# Architecture

The system follows a layered architecture.

```

COPC Source
|
v
Metadata Layer
|
v
Hierarchy Layer
|
v
Point Loading Layer
|
v
Point Reader Layer
|
v
Coordinate Transformation
|
v
Cesium Renderer
|
v
Public Viewer API

```

Each layer has a single responsibility.

---

# Layer Responsibilities

## copc/

Responsible for COPC file processing.

Allowed:

- reading COPC metadata
- parsing hierarchy
- loading point data
- decoding attributes

Forbidden:

- Cesium rendering logic
- camera handling
- browser UI logic

---

## metadata/

Responsible for:

- COPC header parsing
- bounds
- point count
- CRS information
- spacing
- offsets

---

## hierarchy/

Responsible for:

- Octree hierarchy traversal
- Node discovery
- Child node loading
- Node selection support

Must not:

- render points
- access Cesium APIs

---

## points/

Responsible for:

- Point Data loading
- LAZ decoding integration
- Point extraction
- Point Reader implementation

The output should use project-owned types.

Example:

```ts
type CopcPoint = {
  x: number;
  y: number;
  z: number;
};
```

---

## cesium/

Responsible only for visualization.

Allowed:

- Cesium Viewer
- Primitive creation
- GPU rendering
- Camera interaction

Forbidden:

- COPC parsing
- Binary decoding
- File format logic

---

## viewer/

Responsible for orchestration.

Example:

```
CopcViewer

    |
    +-- MetadataLoader

    |
    +-- HierarchyLoader

    |
    +-- PointLoader

    |
    +-- CesiumRenderer
```

Viewer coordinates modules.

Viewer should not contain low-level implementation details.

---

# External Dependency Rules

External libraries:

- copc.js
- laz-perf
- CesiumJS

must be isolated.

Do not expose external types throughout the project.

Avoid:

```ts
Hierarchy.Node;
Copc.Info;
Cesium.Cartesian3;
```

inside core domain types.

Prefer:

```ts
CopcMetadata;
CopcHierarchyNode;
CopcPoint;
```

---

# Rust + WebAssembly Compatibility

The project should be designed so the decoding layer can later be replaced.

Current:

```
copc.js
    |
    v
TypeScript Adapter
    |
    v
Internal Types
```

Future:

```
Rust COPC Decoder
    |
    v
WASM Adapter
    |
    v
Internal Types
```

Do not couple application logic directly to copc.js.

---

# TypeScript Rules

Use strict TypeScript.

Required:

- explicit return types for exported functions
- no unnecessary any
- meaningful type names
- immutable data where possible

Avoid:

```ts
function load(data: any);
```

Prefer:

```ts
function load(data: CopcMetadata): Promise<CopcPoint[]>;
```

---

# Function Rules

Functions should:

- have one responsibility
- be easy to test
- avoid hidden side effects

Recommended:

- under 60 lines per function
- under 300 lines per file

If a function grows too large:

refactor into smaller modules.

---

# Performance Rules

COPC exists because data is large.

Always consider:

- memory usage
- streaming
- unnecessary allocations
- duplicate requests

Avoid:

- loading the entire COPC file into memory
- recreating getters repeatedly
- unnecessary object creation in loops

Prefer:

- lazy loading
- caching
- incremental processing

---

# Testing Rules

Every feature requires tests.

Required:

- unit tests
- integration tests when needed
- type checking

Tests must cover:

- normal cases
- invalid input
- edge cases

---

# Coverage Requirements

Maintain:

```
Line Coverage >= 90%

Branch Coverage >= 85%
```

Critical modules should aim for:

```
100%
```

Especially:

- metadata
- hierarchy
- point decoder
- coordinate transformer

Do not reduce coverage to merge code.

---

# Documentation Rules

Every public module requires documentation.

Exported functions must explain:

- purpose
- parameters
- return values
- important assumptions

Complex algorithms must explain:

- why it exists
- design decisions
- trade-offs

Avoid comments that only repeat code.

Bad:

```ts
// increment index
index++;
```

Good:

```ts
// COPC hierarchy keys are traversed depth-first
// because child nodes must be evaluated only after
// parent visibility is confirmed.
```

---

# Error Handling

Do not silently ignore errors.

Every failure should provide:

- meaningful message
- context
- recovery possibility if applicable

Avoid:

```ts
catch {}
```

Prefer:

```ts
catch(error) {
  throw new CopcLoadError(
    "Failed to load hierarchy",
    { cause:error }
  );
}
```

---

# Commit Rules

Commit must represent one logical change.

Format:

```
type(scope): message
```

Examples:

```
feat(points): implement point reader

feat(hierarchy): load child nodes

refactor(adapter): isolate copc.js types

test(metadata): add parser tests
```

Avoid:

```
update code
fix stuff
changes
```

---

# CI Requirements

Before committing, verify:

Required:

- TypeScript build
- ESLint
- Tests
- Coverage
- Production build

No warnings should remain.

---

# Feature Development Process

Always follow:

```
1. Update types

2. Write tests

3. Implement feature

4. Add documentation

5. Refactor

6. Verify CI
```

Do not implement large features without tests.

---

# AI Agent Rules

When modifying code:

1. Inspect existing architecture first.
2. Do not create duplicate abstractions.
3. Reuse existing types.
4. Preserve folder responsibilities.
5. Add tests for changed behavior.
6. Update documentation if architecture changes.

If unsure:

Prefer asking for clarification rather than creating architectural debt.

---

# Current Project Roadmap

## Phase 1: COPC Reader

- Metadata loading
- Hierarchy parsing
- Point data decoding

## Phase 2: Point Rendering

- Convert COPC points
- Coordinate transformation
- Cesium rendering

## Phase 3: Streaming Viewer

- Node selection
- LoD
- Camera based loading
- Cache

## Phase 4: Library API

- Public API
- Documentation
- Examples

## Phase 5: Rust + WASM

- Replace decoder
- Improve performance
- Production optimization
