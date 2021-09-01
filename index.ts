import * as json2Ts from "json-schema-to-typescript";
import fs from "fs";
import path from "path";
import prettier from "prettier";
import ts from "typescript";
import https from "https";
import crypto from "crypto";
import sv from "standard-version";
import cp from "child_process";

import prettierConfig from "./.prettierrc.json";
import {$schema} from "./tsconfig.json";
import {checksum as previousChecksum} from "./checksum.json";

async function main(): Promise<void> {
    const inDevelopment = await (async (): Promise<boolean> => {
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

    if (!inDevelopment) {
        // Create hash of the final source.
        const hasher = crypto.createHash("md5");
        hasher.update(transformedSourceFormatted);
        const checksum = hasher.digest("hex");

        // Compare checksums.
        if (checksum === previousChecksum) {
            throw new Error("Already released this version.");
        }

        // Write out new checksum for use in subsequent run.
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

    if (!inDevelopment) {
        cp.execSync("git add .", {
            cwd: __dirname,
            stdio: "inherit",
        });
        cp.execSync("git commit -m 'feat: unknown – regenerating from schemastore.org'", {
            cwd: __dirname,
            stdio: "inherit",
        });
        sv({
            releaseAs: "minor",
        });
        cp.execSync("git push --follow-tags origin main && npm publish", {
            cwd: __dirname,
            stdio: "inherit",
        });
    }
}

// Our main transformer is composed of the following transformers.
function getTransformerFactories(): ts.TransformerFactory<ts.Node>[] {
    // prettier-ignore
    return [
        renameTsconfigTypeAndRemoveOtherExports,
        removeStandaloneUnknownRecsInUnions,
        removeStringMergedWithStringLiterals,
        removeUnknownIndexSignatures,
    ];
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

// Removes export modifiers from all statements except for the `Tsconfig` type alias declaration.
// Also renames the following type to `Tsconfig`.
//
// ```
// export type JSONSchemaForTheTypeScriptCompilerSConfigurationFile = CompilerOptionsDefinition & CompileOnSaveDefinition & TypeAcquisitionDefinition & ExtendsDefinition & WatchOptionsDefinition & BuildOptionsDefinition & TsNodeDefinition & (FilesDefinition | ExcludeDefinition | IncludeDefinition | ReferencesDefinition);
// ```

const renameTsconfigTypeAndRemoveOtherExports: ts.TransformerFactory<ts.Node> = (ctx) => (sourceFile) => {
    return ts.visitEachChild(
        sourceFile,
        (statement) => {
            if (ts.isTypeAliasDeclaration(statement)) {
                return ts.factory.updateTypeAliasDeclaration(statement, statement.decorators, statement.modifiers, ts.factory.createIdentifier("Tsconfig"), statement.typeParameters, statement.type);
            } else if (ts.isInterfaceDeclaration(statement)) {
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
                if (ts.isInterfaceDeclaration(child) || ts.isTypeLiteralNode(child)) {
                    const nextMembers = child.members.reduce((acc, cur, i): ts.TypeElement[] => {
                        if (ts.isIndexSignatureDeclaration(cur) && cur.parameters[0]?.type?.kind === ts.SyntaxKind.StringKeyword && cur.type.kind === ts.SyntaxKind.UnknownKeyword && (child.members[i - 1] || child.members[i + 1])) {
                            return acc;
                        }
                        const nextVisited = removeUnknownIndexSignatures(ctx)(cur);
                        if (nextVisited) {
                            return [...acc, nextVisited];
                        }
                        return acc;
                    }, [] as ts.TypeElement[]);
                    if (ts.isInterfaceDeclaration(child)) {
                        return ts.factory.updateInterfaceDeclaration(child, undefined, undefined, child.name, undefined, undefined, nextMembers);
                    }
                    if (ts.isTypeLiteralNode(child)) {
                        return ts.factory.updateTypeLiteralNode(child, ts.factory.createNodeArray(nextMembers));
                    }
                }
                return removeUnknownIndexSignatures(ctx)(child);
            },
            ctx,
        );
    };
}

main();
