import cp from "child_process";
import crypto from "crypto";
import fs from "fs";
import https from "https";
import * as json2Ts from "json-schema-to-typescript";
import path from "path";
import prettier from "prettier";
import sv from "standard-version";
import ts from "typescript";

import prettierConfig from "./.prettierrc.json";
import {checksum as previousChecksum} from "./checksum.json";
import {$schema} from "./tsconfig.json";

async function main(): Promise<void> {
    // When running the `dev` script, a temporary `dev` file is touched in the project root.
    // When running the `prod` script, the file is deleted.
    // Therefore, `inDevelopment` should contain which mode we're currently running.
    // This enables us to prevent version bumps, commits, tagging, etc. (further down in this body).
    const devMode = await (async (): Promise<boolean> => {
        try {
            await fs.promises.stat(path.resolve(__dirname, "dev"));
            return true;
        } catch (e) {
            return false;
        }
    })();

    // Fetch the latest schema from schemastore.org.
    const tsconfigJsonSchema = await new Promise<json2Ts.JSONSchema>((resolve, reject) => {
        https.get($schema, (res) => {
            let source = "";
            res.on("error", reject)
                .on("data", (chunk) => {
                    source += chunk.toString();
                })
                .on("close", async () => {
                    resolve(JSON.parse(source));
                });
        });
    });

    // Generate TypeScript types and interfaces from the fetched schema.
    // This needs to be transformed to better suit our needs (TypeScript transformer below).
    const json2TsResult = await json2Ts.compile(tsconfigJsonSchema, "Tsconfig", {
        bannerComment: "/**\n * THIS FILE WAS GENERATED. BE WARY OF EDITING BY HAND.\n */",
    });

    // Create a source file from the `json-schema-to-typescript` result.
    const initialSourceFile = ts.createSourceFile("tsconfig_type.d.ts", json2TsResult, ts.ScriptTarget.ES2018);

    // Transform the source file.
    const transformedSourceFile = ts.transform(initialSourceFile, [transformer]).transformed[0];

    // Ensure the transformed source file is defined.
    if (!transformedSourceFile) {
        throw new Error("Could not access transformed source file.");
    }

    // Print the transformed source file.
    const transformedSource = ts
        .createPrinter({
            noEmitHelpers: true,
            omitTrailingSemicolon: false,
            removeComments: false,
        })
        .printFile(transformedSourceFile);

    // Format the final source.
    const {importOrder: _0, importOrderSeparation: _1, ...nativePrettierConfig} = prettierConfig;
    const transformedSourceFormatted = prettier.format(transformedSource, {
        ...(nativePrettierConfig as prettier.Options),
        parser: "typescript",
    });

    if (!devMode) {
        // Create checksum of the final source.
        const hasher = crypto.createHash("md5");
        hasher.update(transformedSourceFormatted);
        const checksum = hasher.digest("hex");

        // Compare checksums.
        if (checksum === previousChecksum) {
            throw new Error("Already released this version.");
        }

        // Write out new checksum for use in subsequent run. This gets committed.
        await fs.promises.writeFile(
            path.resolve(__dirname, "checksum.json"),
            JSON.stringify({
                checksum,
            }),
            "utf8",
        );
    }

    // Write the source to disk.
    await fs.promises.writeFile(path.join(__dirname, "the_type.d.ts"), transformedSourceFormatted, "utf8");

    if (!devMode) {
        [
            // Is hardcoding this blasphemous? If so, please file an issue and tell me I'm a buffoon.
            'git config --global user.email "harrysolovay@gmail.com"',
            'git config --global user.name "Harry Solovay"',
            // Even though the only change is the `package.json`...
            "git add .",
            // Can be a chore since we force a minor version bump below.
            // Message kind is therefore irrelevant.
            "git commit -m 'chore: unknown – regenerating from schemastore.org'",
        ].forEach((command) => {
            cp.execSync(command, {
                cwd: __dirname,
                stdio: "inherit",
            });
        });

        // Bump the version and skip changelog generation. We skip the changelog generation because it wouldn't contain
        // any particularly meaningful messages. The artifacts that users care about are generated, not hand-written).
        // Although, one could argue that we should have a changelog of generation-related changes. This would be done
        // via a different tool than `standard-version`, however. Out of scope for now. Might want to do this in an issue
        // that I keep forever open.
        await sv({
            releaseAs: "minor",
            skip: {
                changelog: true,
            },
        });

        // Everything is committed, `standard-version` has bumped the version and tagged the latest commit. We're ready to
        // push the changes. This is happening inside of the CI/CD environment.
        cp.execSync("git push --follow-tags origin main", {
            cwd: __dirname,
            stdio: "inherit",
        });
    }
}

// Our main transformer is composed of the following transformers.
function getTransformerFactories(): ts.TransformerFactory<ts.Node>[] {
    return [attachSchemaPropToTopLevel, renameTsconfigTypeForceIntersectionsRemoveOtherExports, removeStandaloneUnknownRecsInUnions, removeStringMergedWithStringLiterals, removeUnknownIndexSignatures];
}

// This is our main transformer.
const transformer: ts.TransformerFactory<ts.SourceFile> = (ctx) => (sourceFile) => {
    return getTransformerFactories().reduce((result, transform) => {
        const nextResult = transform(ctx)(result);
        if (!ts.isSourceFile(nextResult)) {
            throw new Error();
        }
        return nextResult;
    }, sourceFile);
};

// Adds `$schema?: string` field to the `CompilerOptionsDefinition` interface.
// ^ this isn't a standard `tsconfig.json` field, but it is a standard `package.json` field,
// and is essential for JSON LSPs outside of VSCode.
const attachSchemaPropToTopLevel: ts.TransformerFactory<ts.Node> = (ctx) => (sourceFile) => {
    return ts.visitEachChild(
        sourceFile,
        (statement) => {
            if (ts.isInterfaceDeclaration(statement) && statement.name.text === "CompilerOptionsDefinition") {
                return ts.factory.updateInterfaceDeclaration(statement, statement.decorators, statement.modifiers, statement.name, statement.typeParameters, statement.heritageClauses, ts.factory.createNodeArray([ts.factory.createPropertySignature(undefined, ts.factory.createIdentifier("$schema"), ts.factory.createToken(ts.SyntaxKind.QuestionToken), ts.factory.createLiteralTypeNode(ts.factory.createStringLiteral("https://json.schemastore.org/tsconfig.json", false))), ...statement.members]));
            }
            return statement;
        },
        ctx,
    );
};

// Recursively turns any union type nodes into intersection nodes.
// This is to be used in `renameTsconfigTypeForceIntersectionsRemoveOtherExports`
const unionsToIntersections: ts.TransformerFactory<ts.Node> = (ctx) => (node) => {
    return ts.visitEachChild(
        node,
        (child) => {
            if (ts.isUnionTypeNode(child)) {
                const types = child.types.map((type) => {
                    return unionsToIntersections(ctx)(type);
                }) as ts.TypeNode[];
                return ts.factory.createIntersectionTypeNode(types);
            }
            return unionsToIntersections(ctx)(child);
        },
        ctx,
    );
};

// 1. Removes export modifiers from all statements except for the `Tsconfig` type alias declaration.
// 2. Renames the following type to `Tsconfig`.
// 3. Turns the `Tsconfig` type's child unions into intersections.
//
// ```
// export type JSONSchemaForTheTypeScriptCompilerSConfigurationFile = CompilerOptionsDefinition & CompileOnSaveDefinition & TypeAcquisitionDefinition & ExtendsDefinition & WatchOptionsDefinition & BuildOptionsDefinition & TsNodeDefinition & (FilesDefinition | ExcludeDefinition | IncludeDefinition | ReferencesDefinition);
// ```
const renameTsconfigTypeForceIntersectionsRemoveOtherExports: ts.TransformerFactory<ts.Node> = (ctx) => (sourceFile) => {
    return ts.visitEachChild(
        sourceFile,
        (statement) => {
            if (ts.isTypeAliasDeclaration(statement)) {
                // Return the same node but with the new identifier.
                return ts.factory.updateTypeAliasDeclaration(statement, statement.decorators, statement.modifiers, ts.factory.createIdentifier("Tsconfig"), statement.typeParameters, unionsToIntersections(ctx)(statement.type) as ts.TypeNode);
            }
            if (ts.isInterfaceDeclaration(statement)) {
                // Return the same nodes but without any export modifiers.
                return ts.factory.updateInterfaceDeclaration(
                    statement,
                    statement.decorators,
                    statement.modifiers?.filter((modifier) => {
                        return modifier.kind === ts.SyntaxKind.ExportKeyword;
                    }),
                    statement.name,
                    statement.typeParameters,
                    statement.heritageClauses,
                    statement.members,
                );
            }
            return statement;
        },
        ctx,
    );
};

// For hygene, let's not unnecessarily intersect string literals with a widened string type. For instance:
//
// ```
// module?: (
//   "CommonJS" | "AMD" | "System" | "UMD" | "ES6" | "ES2015" | "ES2020" | "ESNext" | "None"
// ) & string;
// ```

const removeStringMergedWithStringLiterals: ts.TransformerFactory<ts.Node> = (ctx) => (node) => {
    return ts.visitEachChild(
        node,
        (child) => {
            if (intersectsWithStringLiteral(child)) {
                return removeStringMergedWithStringLiterals(ctx)(removeWideStrings(ctx)(child));
            }
            return removeStringMergedWithStringLiterals(ctx)(child);
        },
        ctx,
    );
};

const removeWideStrings: ts.TransformerFactory<ts.Node> = (ctx) => (node) => {
    // If the node is an intersection node, visit its children and strip out any intersected `string`s.
    if (ts.isIntersectionTypeNode(node) || ts.isUnionTypeNode(node)) {
        return ts.visitEachChild(
            node,
            (child) => {
                if (child.kind === ts.SyntaxKind.StringKeyword) {
                    return undefined;
                }
                return removeWideStrings(ctx)(child);
            },
            ctx,
        );
    }
    // In the case that we encounter a parenthesized type, we want to treat this as an immediate child, so we recurse.
    if (ts.isParenthesizedTypeNode(node)) {
        return removeWideStrings(ctx)(node.type);
    }
    return node;
};

// Checks if the current node type is one with an intersected string literal.
function intersectsWithStringLiteral(node: ts.Node): boolean {
    return (
        // The current node is itself a string literal.
        (ts.isLiteralTypeNode(node) && node.literal.kind === ts.SyntaxKind.StringLiteral) ||
        // The current node contains `node`-adjacent types, which flatten into an intersection between `node` and a string literal.
        ((ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) && node.types.some(intersectsWithStringLiteral)) ||
        // The current type is parenthesized. Treat it's children as `node`-adjacent.
        (ts.isParenthesizedTypeNode(node) && intersectsWithStringLiteral(node.type))
    );
}

// There are some unnecessary string-indexed unknown recs unioned with certain types in the `json-schema-to-typescript` output.
// This transform removes said elements from unions (such as the following).
//
// ```
// target?: (
//     | ("ES3" | "ES5" | "ES6" | "ES2015" | "ES2016" | "ES2017" | "ES2018" | "ES2019" | "ES2020" | "ES2021" | "ESNext")
//     | {
//         [k: string]: unknown;
//       }
// )
// ```

const removeStandaloneUnknownRecsInUnions: ts.TransformerFactory<ts.Node> = (ctx) => (node) => {
    // If the node is a union node...
    if (ts.isUnionTypeNode(node)) {
        // We determine which of its members to keep.
        const keep = node.types.filter((type) => {
            // If it's a type literal node with one member...
            if (ts.isTypeLiteralNode(type) && type.members.length === 1) {
                // ... and its first member is an index signature declaration with one parameter of syntax kind `StringKeyword`...
                const firstMember = type.members[0]!;
                if (ts.isIndexSignatureDeclaration(firstMember) && firstMember.parameters.length === 1 && firstMember.parameters[0]!.type?.kind === ts.SyntaxKind.StringKeyword) {
                    // ... then we do not want to keep the node in the union.
                    return false;
                }
            }
            return true;
        });
        // Update the union with the nodes we want to keep.
        return ts.factory.updateUnionTypeNode(
            node,
            ts.factory.createNodeArray(
                keep.map((type) => {
                    return ts.visitEachChild(
                        type,
                        (child) => {
                            return removeStandaloneUnknownRecsInUnions(ctx)(child);
                        },
                        ctx,
                    );
                }),
            ),
        );
    }
    // Incase we don't want to make any changes.
    return ts.visitEachChild(
        node,
        (child) => {
            return removeStandaloneUnknownRecsInUnions(ctx)(child);
        },
        ctx,
    );
};

// Remove string-to-unknown index signatures from interface declarations and type literals.
//
// ````
// plugins?: {
//     name?: string;
//     [k: string]: unknown;
// }[];
// ````

function removeUnknownIndexSignatures(ctx: ts.TransformationContext) {
    return <N extends ts.Node>(node: N): N => {
        return ts.visitEachChild(
            node,
            (child) => {
                // If we're currently visiting an interface declaration or type literal...
                if (ts.isInterfaceDeclaration(child) || ts.isTypeLiteralNode(child)) {
                    // Filter out members which match the following conditions:
                    // 1. Is an index signature declaration.
                    // 2. Has `string` as the index signature.
                    // 3. Has `unknown` as the value.
                    // 4. Has no sibling fields.
                    const keep = child.members.reduce((acc, cur, i): ts.TypeElement[] => {
                        if (ts.isIndexSignatureDeclaration(cur) && cur.parameters[0]?.type?.kind === ts.SyntaxKind.StringKeyword && cur.type.kind === ts.SyntaxKind.UnknownKeyword && (child.members[i - 1] || child.members[i + 1])) {
                            return acc;
                        }
                        const nextVisited = removeUnknownIndexSignatures(ctx)(cur);
                        if (nextVisited) {
                            return [...acc, nextVisited];
                        }
                        return acc;
                    }, [] as ts.TypeElement[]);
                    // Update node with the filtered members.
                    if (ts.isInterfaceDeclaration(child)) {
                        return ts.factory.updateInterfaceDeclaration(child, child.decorators, child.modifiers, child.name, child.typeParameters, child.heritageClauses, keep);
                    }
                    if (ts.isTypeLiteralNode(child)) {
                        return ts.factory.updateTypeLiteralNode(child, ts.factory.createNodeArray(keep));
                    }
                }
                return removeUnknownIndexSignatures(ctx)(child);
            },
            ctx,
        );
    };
}

main();
main();
