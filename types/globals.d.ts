// Globals the type-check cannot see: classic scripts loaded by index.html
// before the modules, the Android shell's bridge, and the import-map modules,
// which are vendored without type declarations.
declare const L: any;
declare const Supercluster: any;

interface FerdAndroidBridge {
  appVersion?(): string;
  exportFile?(name: string, mimeType: string, base64: string): void;
}

interface Window {
  L?: any;
  FerdAndroid?: FerdAndroidBridge;
  ferdCloseTopModal?: () => boolean;
}

declare module 'preact';
declare module 'preact/hooks';
declare module 'htm';
declare module '@preact/signals';
