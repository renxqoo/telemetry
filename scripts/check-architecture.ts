import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import * as ts from 'typescript/unstable/ast';
import { API } from 'typescript/unstable/async';
import { createVirtualFileSystem } from 'typescript/unstable/fs';
async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries
        .filter((entry) => !['node_modules', 'dist', '__test__'].includes(entry.name))
        .map(async (entry) =>
          entry.isDirectory()
            ? files(path.join(directory, entry.name))
            : [path.join(directory, entry.name)],
        ),
    )
  ).flat();
}
function dependencies(source: ts.SourceFile): Set<string> {
  const imports = new Set<string>();
  function add(value: ts.Node | undefined): void {
    if (value && ts.isStringLiteralLikeNode(value)) imports.add(value.text);
  }
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    )
      add(node.moduleReference.expression);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      add(node.argument.literal);
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    )
      add(node.arguments[0]);
    node.forEachChild(visit);
  }
  visit(source);
  return imports;
}
const restrictions: Record<string, string[]> = {
  protocol: ['sdk', 'application', 'storage-contract', 'storage-postgres', 'cli'],
  sdk: ['application', 'storage-contract', 'storage-postgres', 'cli'],
  'storage-contract': ['sdk', 'application', 'storage-postgres', 'cli'],
  'storage-postgres': ['sdk', 'application', 'cli'],
  application: ['sdk', 'storage-postgres', 'cli'],
  cli: ['sdk', 'storage-postgres', 'application'],
};
const workspaces = new Map(
  await Promise.all(
    Object.keys(restrictions).map(async (module) => {
      const root = path.resolve('packages', module);
      const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
        name?: string;
      };
      if (typeof manifest.name !== 'string' || !manifest.name)
        throw new Error('Missing workspace name');
      const sources = (await files(root)).filter((file) => /\.[cm]?[jt]sx?$/.test(file));
      return [module, { root, name: manifest.name, sources }] as const;
    }),
  ),
);
const inputs = Object.fromEntries(
  await Promise.all(
    [...workspaces.values()].flatMap((workspace) =>
      workspace.sources.map(async (file) => [file, await readFile(file, 'utf8')] as const),
    ),
  ),
);
const configFile = path.resolve('.architecture-check/tsconfig.json');
const api = new API({
  cwd: process.cwd(),
  fs: createVirtualFileSystem({
    ...inputs,
    [configFile]: JSON.stringify({
      compilerOptions: { noResolve: true, noLib: true, types: [], allowJs: true, jsx: 'preserve' },
      files: Object.keys(inputs),
    }),
  }),
});
const failures: string[] = [];
try {
  const snapshot = await api.updateSnapshot({ openProjects: [configFile] });
  try {
    const project = snapshot.getProject(configFile);
    if (!project) throw new Error('Cannot parse architecture inputs');
    for (const [module, forbidden] of Object.entries(restrictions))
      for (const file of workspaces.get(module)!.sources) {
        const source = await project.program.getSourceFile(file);
        if (!source) throw new Error(`Cannot parse ${file}`);
        for (const imported of dependencies(source)) {
          const resolved =
            imported.startsWith('.') || path.isAbsolute(imported)
              ? path.resolve(path.dirname(file), imported)
              : undefined;
          for (const other of forbidden) {
            const workspace = workspaces.get(other)!;
            if (
              imported === workspace.name ||
              imported.startsWith(`${workspace.name}/`) ||
              resolved === workspace.root ||
              resolved?.startsWith(`${workspace.root}${path.sep}`)
            )
              failures.push(`${file}: forbidden dependency ${imported}`);
          }
          if (module === 'protocol' && /^(node:|pg$|fastify$|react)/.test(imported))
            failures.push(`${file}: protocol must be runtime independent`);
          if (
            module === 'sdk' &&
            !/\/(server|next-server)\./.test(file) &&
            /^(node:|pg$|fastify$)/.test(imported)
          )
            failures.push(`${file}: SDK browser graph imports ${imported}`);
          if (imported.includes('/__test__/')) failures.push(`${file}: private test dependency`);
        }
      }
  } finally {
    await snapshot.dispose();
  }
} finally {
  await api.close();
}
if (failures.length) throw new Error(failures.join('\n'));
process.stdout.write('Architecture boundaries passed\n');
