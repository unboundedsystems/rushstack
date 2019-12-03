// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import {
  IDocNodeParameters,
  DocCodeSpan,
  DocNode
} from '@microsoft/tsdoc';
import { CustomDocNodeKind } from './CustomDocNodeKind';

/**
 * Constructor parameters for {@link DocLinkedCodeSpan}.
 */
export interface IDocLinkedCodeSpanParameters extends IDocNodeParameters {
  codeSpan: DocCodeSpan;
  urlDestination: string;
}

/**
 * Represents an inline code span that is also a link.
 */
export class DocLinkedCodeSpan extends DocNode {
  public readonly codeSpan: DocCodeSpan;
  public readonly urlDestination: string;

  /**
   * @internal
   */
  public constructor(parameters: IDocLinkedCodeSpanParameters) {
    super(parameters);
    this.codeSpan = parameters.codeSpan;
    this.urlDestination = parameters.urlDestination;
  }

  /** @override */
  public get kind(): string {
    return CustomDocNodeKind.LinkedCodeSpan;
  }
}
