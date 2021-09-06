# Tsconfig Type

A `tsconfig.json` type, regularly regenerated based on [the schemastore.org definition](https://json.schemastore.org/tsconfig.json).

## Installation

```sh
npm i tsconfig-type
```

## Usage

```ts
import {Tsconfig} from "tsconfig-type";

const tsconfig: Tsconfig = {
    // ...
};
```

## Rationale

I was trying to build a tool which would allow users to specify their TypeScript configuration in TypeScript (not JSON). To my dismay, I found no up-to-date type definition. One would think that such a type definition would be exposed from the `typescript` package itself, but it is not. Meanwhile hand-written definitions are prone to fall behind the latest TypeScript versions.

This type is a response to (what I felt) was a lack of great options. `tsconfig-type` is regularly (on a weekly basis) regenerated from the latest JSON schema. First, the generation script fetches the JSON schema and runs it through [`json-schema-to-typescript`](https://github.com/bcherny/json-schema-to-typescript). Next, that output undergoes a series of transforms. Finally, the resulting type is auto-published to NPM with a minor version increment. In this regard, this package does not strictly follow semver (I'd recommend pinning).
