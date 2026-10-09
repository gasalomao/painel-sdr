import { useState } from "react";
import { createRoot } from "react-dom/client";
import { SitePreview } from "../src/components/sites/site-preview";
import { getStarterFiles } from "../src/lib/sites/starter";
import type { WebsiteFiles } from "../src/lib/sites/types";
import "../src/app/globals.css";

const source = (title: string) => `export default function App(){return <main><h1>${title}</h1><button onClick={(event)=>{event.currentTarget.textContent="Evento disparado";setTimeout(()=>{throw new Error("Evento sintético falhou")},0)}}>Falhar evento</button><button onClick={(event)=>{event.currentTarget.textContent="Promessa disparada";Promise.reject(new Error("Promessa sintética falhou"))}}>Falhar promessa</button></main>;}`;
const original = { ...getStarterFiles(), "src/App.tsx": source("Campo A"), "src/styles.css": "body{margin:0;font:20px system-ui;background:#fff;color:#111}main{padding:24px}button{padding:12px;margin:8px}" };
const renderFailure = 'export default function App(){throw new Error("Render sintético falhou");return <h1>Inalcançável</h1>}';
const effectFailure = 'import {useEffect} from "react";export default function App(){useEffect(()=>{throw new Error("Efeito sintético falhou")},[]);return <h1>Candidato com efeito inválido</h1>}';
const initialFailure = new URLSearchParams(window.location.search).get("initial");
const initialFiles = initialFailure === "render" ? { ...original, "src/App.tsx": renderFailure }
  : initialFailure === "syntax" ? { ...original, "src/App.tsx": 'export default function App(){return <h1 title=>Quebrado</h1>}' }
  : original;

function Fixture() {
  const [files, setFiles] = useState<WebsiteFiles>(initialFiles);
  return <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
    <header style={{ display: "flex", flexWrap: "wrap", gap: 12, padding: 12 }}>
      <button onClick={() => setFiles({ ...original, "src/App.tsx": source("Campo B") })}>Texto mesmo tamanho</button>
      <button onClick={() => setFiles({ ...original, "src/App.tsx": 'export default function App(){return <h1 title=>Quebrado</h1>}' })}>Quebrar sintaxe</button>
      <button aria-pressed={files["src/App.tsx"] === renderFailure} onClick={() => setFiles({ ...original, "src/App.tsx": renderFailure })}>Falhar renderização</button>
      <button aria-pressed={files["src/App.tsx"] === effectFailure} onClick={() => setFiles({ ...original, "src/App.tsx": effectFailure })}>Falhar efeito</button>
      <button onClick={() => setFiles({ ...original, "src/App.tsx": 'import {Component} from "react";class Boundary extends Component{state={failed:false};static getDerivedStateFromError(){return {failed:true}}render(){return this.state.failed?<h1>Fallback recuperado</h1>:this.props.children}}function Broken(){throw new Error("Erro tratado")}export default function App(){return <Boundary><Broken/></Boundary>}' })}>Erro tratado</button>
      <button onClick={() => setFiles({ ...original, "src/App.tsx": 'import content from "./content.json";import logo from "./logo.svg";import "./extra.css";export default function App(){return <main><h1>{content.name}</h1><img src={logo} alt="Símbolo agrícola" width="80" height="80"/><p className="asset-note">CSS carregado</p></main>}', "src/content.json": '{"name":"Conteúdo JSON"}', "src/logo.svg": '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80"><path fill="#166534" d="M10 60 Q10 10 65 10 Q70 65 10 60Z"/></svg>', "src/extra.css": '.asset-note{color:rgb(22,101,52)}' })}>JSON CSS SVG</button>
      <button onClick={() => setFiles({ ...original, "src/main.tsx": 'import "./styles.css";export const entrySemRoot=true;' })}>Entry sem montagem</button>
      <button onClick={() => setFiles({ ...original, "index.html": '<html lang="pt-BR"><head><title>const candidate = null;</title></head><body><div id="root"></div></body></html>', "src/App.tsx": source("Marcador literal preservado") })}>HTML com marcador</button>
      <button onClick={() => setFiles({ ...original, "index.html": "HTML inválido\0" })}>HTML inválido</button>
      <button onClick={() => setFiles({ ...original, "src/App.tsx": "" })}>Rascunho incompleto</button>
      <button onClick={() => setFiles(original)}>Restaurar fontes</button>
    </header>
    <SitePreview files={files} revisionId="fixture" projectSlug="fixture" />
  </div>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
