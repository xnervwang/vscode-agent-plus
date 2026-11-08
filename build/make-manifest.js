// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Writes the two descriptor files a .vsix needs, derived from package.json so the identity and version cannot drift
 * from the manifest the editor actually reads. Called by pack.sh with the staging directory as its argument.
 */
const fs = require('fs');
const path = require('path');
const pkg = require('../package.json');

const stage = process.argv[2];
if (!stage) { console.error('usage: node make-manifest.js <staging-dir>'); process.exit(2); }

/* The marketplace icon is optional until one is drawn; without it the two icon entries are left out. */
const icon = pkg.icon ? 'extension/' + pkg.icon : '';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const vsix = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${esc(pkg.name)}" Version="${esc(pkg.version)}" Publisher="${esc(pkg.publisher)}" />
    <DisplayName>${esc(pkg.displayName)}</DisplayName>
    <Description xml:space="preserve">${esc(pkg.description)}</Description>
    <Tags>${esc((pkg.keywords || []).join(','))}</Tags>
    <Categories>${esc((pkg.categories || ['Other']).join(','))}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${esc(pkg.engines.vscode)}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="${esc((pkg.extensionDependencies || []).join(','))}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="${esc((pkg.extensionKind || ['workspace']).join(','))}" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.EnabledApiProposals" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free" />
    </Properties>
${icon ? `    <Icon>${esc(icon)}</Icon>\n` : ''}  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE" Addressable="true" />
${icon ? `    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="${esc(icon)}" Addressable="true" />\n` : ''}  </Assets>
</PackageManifest>
`;

const types = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json" />
  <Default Extension=".js" ContentType="application/javascript" />
  <Default Extension=".md" ContentType="text/markdown" />
  <Default Extension=".py" ContentType="text/x-python" />
  <Default Extension=".html" ContentType="text/html" />
  <Default Extension=".css" ContentType="text/css" />
  <Default Extension=".png" ContentType="image/png" />
  <Default Extension=".svg" ContentType="image/svg+xml" />
  <Default Extension=".txt" ContentType="text/plain" />
  <Default Extension=".vsixmanifest" ContentType="text/xml" />
</Types>
`;

fs.writeFileSync(path.join(stage, 'extension.vsixmanifest'), vsix);
fs.writeFileSync(path.join(stage, '[Content_Types].xml'), types);
console.log(`manifest for ${pkg.publisher}.${pkg.name} ${pkg.version}`);
