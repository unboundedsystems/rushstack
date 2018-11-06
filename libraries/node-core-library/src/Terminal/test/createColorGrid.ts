// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

/**
 * This file is a little program that prints all of the colors to the console
 */

import {
  Colors,
  IColorableSequence
} from '../../index';

export function createColorGrid(): IColorableSequence[][] {
  const foregroundFunctions: ((text: string | IColorableSequence) => IColorableSequence)[] = [
    (text) => Colors._normalizeStringOrColorableSequence(text),
    Colors.black,
    Colors.white,
    Colors.gray,
    Colors.magenta,
    Colors.red,
    Colors.yellow,
    Colors.green,
    Colors.cyan,
    Colors.blue
  ];

  const backgroundFunctions: ((text: string | IColorableSequence) => IColorableSequence)[] = [
    (text) => Colors._normalizeStringOrColorableSequence(text),
    Colors.blackBackground,
    Colors.whiteBackground,
    Colors.grayBackground,
    Colors.magentaBackground,
    Colors.redBackground,
    Colors.yellowBackground,
    Colors.greenBackground,
    Colors.cyanBackground,
    Colors.blueBackground
  ];

  const lines: IColorableSequence[][] = [];

  for (const backgroundFunction of backgroundFunctions) {
    const sequence: IColorableSequence[] = [];

    for (const foregroundFunction of foregroundFunctions) {
      sequence.push(backgroundFunction(foregroundFunction('X')));
    }

    lines.push(sequence);
  }

  return lines;
}
