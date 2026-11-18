import React, { useState } from 'react';
import { api } from '../lib/api';

const Auth = ({ onLogin }) => {
  const [isLogin, setIsLogin] = useState(true);
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    username: '',
    email: '',
    password: ''
  });

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);

    const endpoint = isLogin ? '/api/auth/login' : '/api/auth/signup';

    // Payload Cleaning: the login endpoint only accepts credentials.
    const payload = isLogin
      ? { email: formData.email, password: formData.password }
      : formData;

    try {
      const res = await api.post(endpoint, payload);

      if (isLogin) {
        localStorage.setItem('token', res.data.token);
        onLogin(res.data.user, res.data.token);
      } else {
        alert(res.data.msg || "Identity Created. Please Authorize.");
        setIsLogin(true);
      }
    } catch (err) {
      const errorMsg = err.response?.data?.msg || "Authentication Protocol Failed.";
      alert(errorMsg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-void px-4 py-10">
      <div className="panel-raised w-full max-w-md p-6 sm:p-8">
        <div className="mb-7 text-center">
          <span className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl border border-violet/40 bg-violet/15 font-display text-lg font-bold text-ultraviolet text-glow-violet">
            N
          </span>
          <h1 className="font-display text-2xl font-semibold tracking-tight">NexusTrade</h1>
          <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.2em] text-ink-muted">
            {isLogin ? 'Secure terminal access' : 'Create trading identity'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          {!isLogin && (
            <input
              type="text"
              placeholder="Username"
              aria-label="Username"
              className="control w-full"
              onChange={(e) => setFormData({ ...formData, username: e.target.value })}
              required
            />
          )}

          <input
            type="email"
            placeholder="Email address"
            aria-label="Email address"
            className="control w-full"
            onChange={(e) => setFormData({ ...formData, email: e.target.value })}
            required
          />

          <input
            type="password"
            placeholder="Password"
            aria-label="Password"
            className="control w-full"
            onChange={(e) => setFormData({ ...formData, password: e.target.value })}
            required
          />

          <button
            disabled={loading}
            className="mt-2 w-full rounded-lg bg-violet py-3 text-sm font-semibold text-void transition-colors hover:bg-ultraviolet disabled:opacity-50"
          >
            {loading ? 'Processing…' : isLogin ? 'Authorize access' : 'Create identity'}
          </button>
        </form>

        <div className="mt-7 border-t border-line-subtle pt-5 text-center">
          <p className="text-xs text-ink-muted">
            {isLogin ? 'New to the platform?' : 'Credentials already exist?'}
            <button
              className="ml-2 font-semibold text-ultraviolet transition-colors hover:text-aqua"
              onClick={() => setIsLogin(!isLogin)}
            >
              {isLogin ? 'Register' : 'Sign in'}
            </button>
          </p>
        </div>
      </div>
    </div>
  );
};

export default Auth;
