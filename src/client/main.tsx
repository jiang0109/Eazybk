import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthGate } from './components/auth/AuthGate';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('找不到 #root 挂载点');

createRoot(container).render(
  <StrictMode>
    {/*
      入口是 AuthGate 而不是 AppShell：
      先确认登录状态，再决定显示登录页还是主应用。
      这样"未登录"是一条明确的路径，而不是等某个接口返回 401 才被动发现。
    */}
    <AuthGate />
  </StrictMode>,
);
