export class ClassInNamespace {
    self() { return this; }
}

export let namespaceVariable: ClassInNamespace | undefined;

export function namespaceFunc() {
    return new ClassInNamespace();
}

export namespace foo {
    export var bar: number;
}