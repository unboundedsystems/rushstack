// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as ts from 'typescript';
import { InternalError } from '@microsoft/node-core-library';

import { TypeScriptHelpers } from './TypeScriptHelpers';
import { AstSymbol } from './AstSymbol';
import { AstImport, IAstImportOptions, AstImportKind } from './AstImport';
import { AstModule, AstModuleExportInfo } from './AstModule';
import { TypeScriptInternals } from './TypeScriptInternals';
import { TypeScriptMessageFormatter } from './TypeScriptMessageFormatter';
import { IFetchAstSymbolOptions, AstEntity } from './AstSymbolTable';

/**
 * Exposes the minimal APIs from AstSymbolTable that are needed by ExportAnalyzer.
 *
 * In particular, we want ExportAnalyzer to be able to call AstSymbolTable._fetchAstSymbol() even though it
 * is a very private API that should not be exposed to any other components.
 */
export interface IAstSymbolTable {
  fetchAstSymbol(options: IFetchAstSymbolOptions): AstSymbol | undefined;

  analyze(astSymbol: AstSymbol): void;
}

/**
 * Used with ExportAnalyzer.fetchAstModuleBySourceFile() to provide contextual information about how the source file
 * was imported.
 */
interface IAstModuleReference {
  /**
   * For example, if we are following a statement like `import { X } from 'some-package'`, this will be the
   * string `"some-package"`.
   */
  moduleSpecifier: string;

  /**
   * For example, if we are following a statement like `import { X } from 'some-package'`, this will be the
   * symbol for `X`.
   */
  moduleSpecifierSymbol: ts.Symbol;
}

/**
 * The ExportAnalyzer is an internal part of AstSymbolTable that has been moved out into its own source file
 * because it is a complex and mostly self-contained algorithm.
 *
 * Its job is to build up AstModule objects by crawling import statements to discover where declarations come from.
 * This is conceptually the same as the compiler's own TypeChecker.getExportsOfModule(), except that when
 * ExportAnalyzer encounters a declaration that was imported from an external package, it remembers how it was imported
 * (i.e. the AstImport object).  Today the compiler API does not expose this information, which is crucial for
 * generating .d.ts rollups.
 */
export class ExportAnalyzer {
  private readonly _program: ts.Program;
  private readonly _typeChecker: ts.TypeChecker;
  private readonly _astSymbolTable: IAstSymbolTable;

  private readonly _astModulesByModuleSymbol: Map<ts.Symbol, AstModule>
    = new Map<ts.Symbol, AstModule>();

  // Used with isImportableAmbientSourceFile()
  private readonly _importableAmbientSourceFiles: Set<ts.SourceFile> = new Set<ts.SourceFile>();

  private readonly _astImportsByKey: Map<string, AstImport> = new Map<string, AstImport>();

  public constructor(program: ts.Program, typeChecker: ts.TypeChecker, astSymbolTable: IAstSymbolTable) {
    this._program = program;
    this._typeChecker = typeChecker;
    this._astSymbolTable = astSymbolTable;
  }

  /**
   * For a given source file, this analyzes all of its exports and produces an AstModule object.
   *
   * @param moduleReference - contextual information about the import statement that took us to this source file.
   * or `undefined` if this source file is the initial entry point
   */
  public fetchAstModuleFromSourceFile(sourceFile: ts.SourceFile,
    moduleReference: IAstModuleReference | undefined): AstModule {

    const moduleSymbol: ts.Symbol = this._getModuleSymbolFromSourceFile(sourceFile, moduleReference);

    // Don't traverse into a module that we already processed before:
    // The compiler allows m1 to have "export * from 'm2'" and "export * from 'm3'",
    // even if m2 and m3 both have "export * from 'm4'".
    let astModule: AstModule | undefined = this._astModulesByModuleSymbol.get(moduleSymbol);
    if (!astModule) {

      // (If moduleReference === undefined, then this is the entry point of the local project being analyzed.)
      let externalModulePath: string | undefined = undefined;
      if (moduleReference !== undefined) {
        // Match:       "@microsoft/sp-lodash-subset" or "lodash/has"
        // but ignore:  "../folder/LocalFile"
        if (!ts.isExternalModuleNameRelative(moduleReference.moduleSpecifier)) {
          externalModulePath = moduleReference.moduleSpecifier;
        }
      }

      astModule = new AstModule({ sourceFile,  moduleSymbol, externalModulePath });

      this._astModulesByModuleSymbol.set(moduleSymbol, astModule);

      if (astModule.isExternal) {
        // It's an external package, so do the special simplified analysis that doesn't crawl into referenced modules
        for (const exportedSymbol of this._typeChecker.getExportsOfModule(moduleSymbol)) {

          if (externalModulePath === undefined) {
            throw new InternalError('Failed assertion: externalModulePath=undefined but astModule.isExternal=true');
          }

          const followedSymbol: ts.Symbol = TypeScriptHelpers.followAliases(exportedSymbol, this._typeChecker);

          // Ignore virtual symbols that don't have any declarations
          if (TypeScriptHelpers.hasAnyDeclarations(followedSymbol)) {
            const astSymbol: AstSymbol | undefined = this._astSymbolTable.fetchAstSymbol({
              followedSymbol: followedSymbol,
              isExternal: astModule.isExternal,
              includeNominalAnalysis: true,
              addIfMissing: true
            });

            if (!astSymbol) {
              throw new Error(`Unsupported export ${JSON.stringify(exportedSymbol.name)} in `
                + TypeScriptMessageFormatter.formatFileAndLineNumber(followedSymbol.declarations[0]));
            }

            astModule.cachedExportedEntities.set(exportedSymbol.name, astSymbol);
          }
        }
      } else {
        // The module is part of the local project, so do the full analysis

        if (moduleSymbol.exports) {
          // The "export * from 'module-name';" declarations are all attached to a single virtual symbol
          // whose name is InternalSymbolName.ExportStar
          const exportStarSymbol: ts.Symbol | undefined = moduleSymbol.exports.get(ts.InternalSymbolName.ExportStar);
          if (exportStarSymbol) {
            for (const exportStarDeclaration of exportStarSymbol.getDeclarations() || []) {
              if (ts.isExportDeclaration(exportStarDeclaration)) {

                const starExportedModule: AstModule | undefined = this._fetchSpecifierAstModule(exportStarDeclaration,
                  exportStarSymbol);

                if (starExportedModule !== undefined) {
                  astModule.starExportedModules.add(starExportedModule);
                }
              } else {
                // Ignore ExportDeclaration nodes that don't match the expected pattern
                // TODO: Should we report a warning?
              }
            }
          }
        }

      }
    }

    return astModule;
  }

  /**
   * Retrieves the symbol for the module corresponding to the ts.SourceFile that is being imported/exported.
   *
   * @remarks
   * The `module` keyword can be used to declare multiple TypeScript modules inside a single source file.
   * (This is a deprecated construct and mainly used for typings such as `@types/node`.)  In this situation,
   * `moduleReference` helps us to fish out the correct module symbol.
   */
  private _getModuleSymbolFromSourceFile(sourceFile: ts.SourceFile,
    moduleReference: IAstModuleReference | undefined): ts.Symbol {

    const moduleSymbol: ts.Symbol | undefined = TypeScriptInternals.tryGetSymbolForDeclaration(sourceFile,
      this._typeChecker);
    if (moduleSymbol !== undefined) {
      // This is the normal case.  The SourceFile acts is a module and has a symbol.
      return moduleSymbol;
    }

    if (moduleReference !== undefined) {
      // But there is also an elaborate case where the source file contains one or more "module" declarations,
      // and our moduleReference took us to one of those.

      // tslint:disable-next-line:no-bitwise
      if ((moduleReference.moduleSpecifierSymbol.flags & ts.SymbolFlags.Alias) !== 0) {
        // Follow the import/export declaration to one hop the exported item inside the target module
        let followedSymbol: ts.Symbol | undefined = TypeScriptInternals.getImmediateAliasedSymbol(
          moduleReference.moduleSpecifierSymbol, this._typeChecker);

        if (followedSymbol === undefined) {
          // This is a workaround for a compiler bug where getImmediateAliasedSymbol() sometimes returns undefined
          followedSymbol = this._typeChecker.getAliasedSymbol(moduleReference.moduleSpecifierSymbol);
        }

        if (followedSymbol !== undefined && followedSymbol !== moduleReference.moduleSpecifierSymbol) {
          // The parent of the exported symbol will be the module that we're importing from
          const parent: ts.Symbol | undefined = TypeScriptInternals.getSymbolParent(followedSymbol);
          if (parent !== undefined) {
            // Make sure the thing we found is a module
            // tslint:disable-next-line:no-bitwise
            if ((parent.flags & ts.SymbolFlags.ValueModule) !== 0) {
              // Record that that this is an ambient module that can also be imported from
              this._importableAmbientSourceFiles.add(sourceFile);
              return parent;
            }
          }
        }
      }
    }

    throw new InternalError('Unable to determine module for: ' + sourceFile.fileName);
  }

  /**
   * Implementation of {@link AstSymbolTable.fetchAstModuleExportInfo}.
   */
  public fetchAstModuleExportInfo(entryPointAstModule: AstModule): AstModuleExportInfo {
    if (entryPointAstModule.isExternal) {
      throw new Error('fetchAstModuleExportInfo() is not supported for external modules');
    }

    if (entryPointAstModule.astModuleExportInfo === undefined) {
      const astModuleExportInfo: AstModuleExportInfo = new AstModuleExportInfo();

      this._collectAllExportsRecursive(astModuleExportInfo, entryPointAstModule,
        new Set<AstModule>());

      entryPointAstModule.astModuleExportInfo = astModuleExportInfo;
    }
    return entryPointAstModule.astModuleExportInfo;
  }

  /**
   * Returns true if when we analyzed sourceFile, we found that it contains an "export=" statement that allows
   * it to behave /either/ as an ambient module /or/ as a regular importable module.  In this case,
   * `AstSymbolTable._fetchAstSymbol()` will analyze its symbols even though `TypeScriptHelpers.isAmbient()`
   * returns true.
   */
  public isImportableAmbientSourceFile(sourceFile: ts.SourceFile): boolean {
    return this._importableAmbientSourceFiles.has(sourceFile);
  }

  private _collectAllExportsRecursive(astModuleExportInfo: AstModuleExportInfo, astModule: AstModule,
    visitedAstModules: Set<AstModule>): void {

    if (visitedAstModules.has(astModule)) {
      return;
    }
    visitedAstModules.add(astModule);

    if (astModule.isExternal) {
      astModuleExportInfo.starExportedExternalModules.add(astModule);
    } else {
      // Fetch each of the explicit exports for this module
      if (astModule.moduleSymbol.exports) {
        astModule.moduleSymbol.exports.forEach((exportSymbol, exportName) => {
          switch (exportName) {
            case ts.InternalSymbolName.ExportStar:
            case ts.InternalSymbolName.ExportEquals:
              break;
            default:
              // Don't collect the "export default" symbol unless this is the entry point module
              if (exportName !== ts.InternalSymbolName.Default || visitedAstModules.size === 1) {
                if (!astModuleExportInfo.exportedLocalEntities.has(exportSymbol.name)) {
                  const astEntity: AstEntity = this._getExportOfAstModule(exportSymbol.name, astModule);

                  if (astEntity instanceof AstSymbol && !astEntity.isExternal) {
                    this._astSymbolTable.analyze(astEntity);
                  }

                  astModuleExportInfo.exportedLocalEntities.set(exportSymbol.name, astEntity);
                }
              }
              break;
          }
        });
      }

      for (const starExportedModule of astModule.starExportedModules) {
        this._collectAllExportsRecursive(astModuleExportInfo, starExportedModule, visitedAstModules);
      }
    }
  }

  /**
   * For a given symbol (which was encountered in the specified sourceFile), this fetches the AstEntity that it
   * refers to.  For example, if a particular interface describes the return value of a function, this API can help
   * us determine a TSDoc declaration reference for that symbol (if the symbol is exported).
   */
  public fetchReferencedAstEntity(symbol: ts.Symbol, referringModuleIsExternal: boolean): AstEntity | undefined {
    let current: ts.Symbol = symbol;

    if (referringModuleIsExternal) {
      current = TypeScriptHelpers.followAliases(symbol, this._typeChecker);
    } else {
      while (true) { // tslint:disable-line:no-constant-condition
        // Is this symbol an import/export that we need to follow to find the real declaration?
        for (const declaration of current.declarations || []) {

          let matchedAstEntity: AstEntity | undefined;
          matchedAstEntity = this._tryMatchExportDeclaration(declaration, current);
          if (matchedAstEntity !== undefined) {
            return matchedAstEntity;
          }
          matchedAstEntity = this._tryMatchImportDeclaration(declaration, current);
          if (matchedAstEntity !== undefined) {
            return matchedAstEntity;
          }
        }

        if (!(current.flags & ts.SymbolFlags.Alias)) { // tslint:disable-line:no-bitwise
          break;
        }

        const currentAlias: ts.Symbol = TypeScriptInternals.getImmediateAliasedSymbol(current, this._typeChecker);
        // Stop if we reach the end of the chain
        if (!currentAlias || currentAlias === current) {
          break;
        }

        current = currentAlias;
      }
    }

    // Otherwise, assume it is a normal declaration
    const astSymbol: AstSymbol | undefined = this._astSymbolTable.fetchAstSymbol({
      followedSymbol: current,
      isExternal: referringModuleIsExternal,
      includeNominalAnalysis: false,
      addIfMissing: true
    });

    return astSymbol;
  }

  private _tryMatchExportDeclaration(declaration: ts.Declaration, declarationSymbol: ts.Symbol): AstEntity | undefined {
    const exportDeclaration: ts.ExportDeclaration | undefined
      = TypeScriptHelpers.findFirstParent<ts.ExportDeclaration>(declaration, ts.SyntaxKind.ExportDeclaration);

    if (exportDeclaration) {
      let exportName: string | undefined = undefined;

      if (declaration.kind === ts.SyntaxKind.ExportSpecifier) {
        // EXAMPLE:
        // "export { A } from './file-a';"
        //
        // ExportDeclaration:
        //   ExportKeyword:  pre=[export] sep=[ ]
        //   NamedExports:
        //     FirstPunctuation:  pre=[{] sep=[ ]
        //     SyntaxList:
        //       ExportSpecifier:  <------------- declaration
        //         Identifier:  pre=[A] sep=[ ]
        //     CloseBraceToken:  pre=[}] sep=[ ]
        //   FromKeyword:  pre=[from] sep=[ ]
        //   StringLiteral:  pre=['./file-a']
        //   SemicolonToken:  pre=[;]

        // Example: " ExportName as RenamedName"
        const exportSpecifier: ts.ExportSpecifier = declaration as ts.ExportSpecifier;
        exportName = (exportSpecifier.propertyName || exportSpecifier.name).getText().trim();
      } else {
        throw new InternalError('Unimplemented export declaration kind: ' + declaration.getText());
      }

      // Ignore "export { A }" without a module specifier
      if (exportDeclaration.moduleSpecifier) {
        const externalModulePath: string | undefined = this._tryGetExternalModulePath(exportDeclaration,
          declarationSymbol);

        if (externalModulePath !== undefined) {
          return this._fetchAstImport(declarationSymbol, {
            importKind: AstImportKind.NamedImport,
            modulePath: externalModulePath,
            exportName: exportName
          });
        }

        return this._getExportOfSpecifierAstModule(exportName, exportDeclaration, declarationSymbol);
      }
    }

    return undefined;
  }

  private _tryMatchImportDeclaration(declaration: ts.Declaration, declarationSymbol: ts.Symbol): AstEntity | undefined {
    const importDeclaration: ts.ImportDeclaration | undefined
      = TypeScriptHelpers.findFirstParent<ts.ImportDeclaration>(declaration, ts.SyntaxKind.ImportDeclaration);

    if (importDeclaration) {
      const externalModulePath: string | undefined = this._tryGetExternalModulePath(importDeclaration,
        declarationSymbol);

      if (declaration.kind === ts.SyntaxKind.NamespaceImport) {
        // EXAMPLE:
        // "import * as theLib from 'the-lib';"
        //
        // ImportDeclaration:
        //   ImportKeyword:  pre=[import] sep=[ ]
        //   ImportClause:
        //     NamespaceImport:  <------------- declaration
        //       AsteriskToken:  pre=[*] sep=[ ]
        //       AsKeyword:  pre=[as] sep=[ ]
        //       Identifier:  pre=[theLib] sep=[ ]
        //   FromKeyword:  pre=[from] sep=[ ]
        //   StringLiteral:  pre=['the-lib']
        //   SemicolonToken:  pre=[;]

        if (externalModulePath === undefined) {
          const followedSymbol: ts.Symbol =
            TypeScriptHelpers.followAliases(declarationSymbol, this._typeChecker);
          return this._astSymbolTable.fetchAstSymbol({
            followedSymbol,
            isExternal: false,
            isNamespaceImport: true,
            addIfMissing: true,
            includeNominalAnalysis: true,
            localName: declarationSymbol.getName()
          });
        }

        // Here importSymbol=undefined because {@inheritDoc} and such are not going to work correctly for
        // a package or source file.
        return this._fetchAstImport(undefined, {
          importKind: AstImportKind.StarImport,
          exportName: declarationSymbol.name,
          modulePath: externalModulePath
        });
      }

      if (declaration.kind === ts.SyntaxKind.ImportSpecifier) {
        // EXAMPLE:
        // "import { A, B } from 'the-lib';"
        //
        // ImportDeclaration:
        //   ImportKeyword:  pre=[import] sep=[ ]
        //   ImportClause:
        //     NamedImports:
        //       FirstPunctuation:  pre=[{] sep=[ ]
        //       SyntaxList:
        //         ImportSpecifier:  <------------- declaration
        //           Identifier:  pre=[A]
        //         CommaToken:  pre=[,] sep=[ ]
        //         ImportSpecifier:
        //           Identifier:  pre=[B] sep=[ ]
        //       CloseBraceToken:  pre=[}] sep=[ ]
        //   FromKeyword:  pre=[from] sep=[ ]
        //   StringLiteral:  pre=['the-lib']
        //   SemicolonToken:  pre=[;]

        // Example: " ExportName as RenamedName"
        const importSpecifier: ts.ImportSpecifier = declaration as ts.ImportSpecifier;
        const exportName: string = (importSpecifier.propertyName || importSpecifier.name).getText().trim();

        if (externalModulePath !== undefined) {
          return this._fetchAstImport(declarationSymbol, {
            importKind: AstImportKind.NamedImport,
            modulePath: externalModulePath,
            exportName: exportName
          });
        }

        return this._getExportOfSpecifierAstModule(exportName, importDeclaration, declarationSymbol);
      } else if (declaration.kind === ts.SyntaxKind.ImportClause) {
        // EXAMPLE:
        // "import A, { B } from './A';"
        //
        // ImportDeclaration:
        //   ImportKeyword:  pre=[import] sep=[ ]
        //   ImportClause:  <------------- declaration (referring to A)
        //     Identifier:  pre=[A]
        //     CommaToken:  pre=[,] sep=[ ]
        //     NamedImports:
        //       FirstPunctuation:  pre=[{] sep=[ ]
        //       SyntaxList:
        //         ImportSpecifier:
        //           Identifier:  pre=[B] sep=[ ]
        //       CloseBraceToken:  pre=[}] sep=[ ]
        //   FromKeyword:  pre=[from] sep=[ ]
        //   StringLiteral:  pre=['./A']
        //   SemicolonToken:  pre=[;]

        const importClause: ts.ImportClause = declaration as ts.ImportClause;
        const exportName: string = importClause.name ?
          importClause.name.getText().trim() : ts.InternalSymbolName.Default;

        if (externalModulePath !== undefined) {
          return this._fetchAstImport(declarationSymbol, {
            importKind: AstImportKind.DefaultImport,
            modulePath: externalModulePath,
            exportName
          });
        }

        return this._getExportOfSpecifierAstModule(ts.InternalSymbolName.Default, importDeclaration, declarationSymbol);
      } else {
        throw new InternalError('Unimplemented import declaration kind: ' + declaration.getText());
      }
    }

    if (ts.isImportEqualsDeclaration(declaration)) {
      // EXAMPLE:
      // import myLib = require('my-lib');
      //
      // ImportEqualsDeclaration:
      //   ImportKeyword:  pre=[import] sep=[ ]
      //   Identifier:  pre=[myLib] sep=[ ]
      //   FirstAssignment:  pre=[=] sep=[ ]
      //   ExternalModuleReference:
      //     RequireKeyword:  pre=[require]
      //     OpenParenToken:  pre=[(]
      //     StringLiteral:  pre=['my-lib']
      //     CloseParenToken:  pre=[)]
      //   SemicolonToken:  pre=[;]
      if (ts.isExternalModuleReference(declaration.moduleReference)) {
        if (ts.isStringLiteralLike(declaration.moduleReference.expression)) {
          const variableName: string = TypeScriptInternals.getTextOfIdentifierOrLiteral(
            declaration.name);
          const externalModuleName: string = TypeScriptInternals.getTextOfIdentifierOrLiteral(
            declaration.moduleReference.expression);

          return this._fetchAstImport(declarationSymbol, {
            importKind: AstImportKind.EqualsImport,
            modulePath: externalModuleName,
            exportName: variableName
          });
        }
      }
    }

    return undefined;
  }

  private _getExportOfSpecifierAstModule(exportName: string,
    importOrExportDeclaration: ts.ImportDeclaration | ts.ExportDeclaration,
    exportSymbol: ts.Symbol): AstEntity {

    const specifierAstModule: AstModule = this._fetchSpecifierAstModule(importOrExportDeclaration, exportSymbol);
    const astEntity: AstEntity = this._getExportOfAstModule(exportName, specifierAstModule);
    return astEntity;
  }

  private _getExportOfAstModule(exportName: string, astModule: AstModule): AstEntity {

    const visitedAstModules: Set<AstModule> = new Set<AstModule>();
    const astEntity: AstEntity | undefined = this._tryGetExportOfAstModule(exportName, astModule,
      visitedAstModules);
    if (astEntity === undefined) {
      throw new InternalError(`Unable to analyze the export ${JSON.stringify(exportName)} in\n`
        + astModule.sourceFile.fileName);
    }
    return astEntity;
  }

  /**
   * Implementation of {@link AstSymbolTable.tryGetExportOfAstModule}.
   */
  public tryGetExportOfAstModule(exportName: string, astModule: AstModule): AstEntity | undefined {
    const visitedAstModules: Set<AstModule> = new Set<AstModule>();
    return this._tryGetExportOfAstModule(exportName, astModule,
      visitedAstModules);
  }

  private _tryGetExportOfAstModule(exportName: string, astModule: AstModule,
    visitedAstModules: Set<AstModule>): AstEntity | undefined {

    if (visitedAstModules.has(astModule)) {
      return undefined;
    }
    visitedAstModules.add(astModule);

    let astEntity: AstEntity | undefined = astModule.cachedExportedEntities.get(exportName);
    if (astEntity !== undefined) {
      return astEntity;
    }

    // Try the explicit exports
    const escapedExportName: ts.__String = ts.escapeLeadingUnderscores(exportName);
    if (astModule.moduleSymbol.exports) {
      const exportSymbol: ts.Symbol | undefined = astModule.moduleSymbol.exports.get(escapedExportName);
      if (exportSymbol) {
        astEntity = this.fetchReferencedAstEntity(exportSymbol, astModule.isExternal);

        if (astEntity !== undefined) {
          astModule.cachedExportedEntities.set(exportName, astEntity); // cache for next time
          return astEntity;
        }
      }
    }

    // Try each of the star imports
    for (const starExportedModule of astModule.starExportedModules) {
      astEntity = this._tryGetExportOfAstModule(exportName, starExportedModule, visitedAstModules);

      if (astEntity !== undefined) {

        if (starExportedModule.externalModulePath !== undefined) {
          // This entity was obtained from an external module, so return an AstImport instead
          const astSymbol: AstSymbol = astEntity as AstSymbol;
          return this._fetchAstImport(astSymbol.followedSymbol, {
            importKind: AstImportKind.NamedImport,
            modulePath: starExportedModule.externalModulePath,
            exportName: exportName
          });
        }

        return astEntity;
      }
    }

    return undefined;
  }

  private _tryGetExternalModulePath(importOrExportDeclaration: ts.ImportDeclaration | ts.ExportDeclaration,
    exportSymbol: ts.Symbol): string | undefined {

      // The name of the module, which could be like "./SomeLocalFile' or like 'external-package/entry/point'
    const moduleSpecifier: string | undefined = TypeScriptHelpers.getModuleSpecifier(importOrExportDeclaration);
    if (!moduleSpecifier) {
      throw new InternalError('Unable to parse module specifier');
    }

    // Match:       "@microsoft/sp-lodash-subset" or "lodash/has"
    // but ignore:  "../folder/LocalFile"
    if (!ts.isExternalModuleNameRelative(moduleSpecifier)) {
      return moduleSpecifier;
    }

    return undefined;
  }

  /**
   * Given an ImportDeclaration of the form `export { X } from "___";`, this interprets the module specifier (`"___"`)
   * and fetches the corresponding AstModule object.
   */
  private _fetchSpecifierAstModule(importOrExportDeclaration: ts.ImportDeclaration | ts.ExportDeclaration,
    exportSymbol: ts.Symbol): AstModule {

    // The name of the module, which could be like "./SomeLocalFile' or like 'external-package/entry/point'
    const moduleSpecifier: string | undefined = TypeScriptHelpers.getModuleSpecifier(importOrExportDeclaration);
    if (!moduleSpecifier) {
      throw new InternalError('Unable to parse module specifier');
    }

    const resolvedModule: ts.ResolvedModuleFull | undefined = TypeScriptInternals.getResolvedModule(
      importOrExportDeclaration.getSourceFile(), moduleSpecifier);

    if (resolvedModule === undefined) {
      // This should not happen, since getResolvedModule() specifically looks up names that the compiler
      // found in export declarations for this source file
      throw new InternalError('getResolvedModule() could not resolve module name ' + JSON.stringify(moduleSpecifier));
    }

    // Map the filename back to the corresponding SourceFile. This circuitous approach is needed because
    // we have no way to access the compiler's internal resolveExternalModuleName() function
    const moduleSourceFile: ts.SourceFile | undefined = this._program.getSourceFile(resolvedModule.resolvedFileName);
    if (!moduleSourceFile) {
      // This should not happen, since getResolvedModule() specifically looks up names that the compiler
      // found in export declarations for this source file
      throw new InternalError('getSourceFile() failed to locate ' + JSON.stringify(resolvedModule.resolvedFileName));
    }

    const moduleReference: IAstModuleReference = {
      moduleSpecifier: moduleSpecifier,
      moduleSpecifierSymbol: exportSymbol
    };
    const specifierAstModule: AstModule = this.fetchAstModuleFromSourceFile(moduleSourceFile, moduleReference);

    return specifierAstModule;
  }

  private _fetchAstImport(importSymbol: ts.Symbol | undefined, options: IAstImportOptions): AstImport {
    const key: string = AstImport.getKey(options);

    let astImport: AstImport | undefined = this._astImportsByKey.get(key);

    if (!astImport) {
      astImport = new AstImport(options);
      this._astImportsByKey.set(key, astImport);

      if (importSymbol) {
        const followedSymbol: ts.Symbol = TypeScriptHelpers.followAliases(importSymbol, this._typeChecker);

        astImport.astSymbol = this._astSymbolTable.fetchAstSymbol({
          followedSymbol: followedSymbol,
          isExternal: true,
          includeNominalAnalysis: false,
          addIfMissing: true
        });
      }
    }

    return astImport;
  }
}
