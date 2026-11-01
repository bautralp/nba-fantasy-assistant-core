import { WorkspaceProvider } from './WorkspaceContext';
import { ApplicationMenu } from './ApplicationMenu';
import './App.css';
import './metallic.css';

export function App() { return <WorkspaceProvider><ApplicationMenu /></WorkspaceProvider>; }
