import React, { useState } from 'react';
import axios from 'axios';

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

    // 🚀 OPTIMIZATION 1: Payload Cleaning
    // Removes the 'username' field during login to prevent Backend 400 errors
    const payload = isLogin 
      ? { email: formData.email, password: formData.password } 
      : formData;

    try {
      const res = await axios.post(`https://trading-algo-nqud.onrender.com${endpoint}`, payload);

      if (isLogin) {
        // 🚀 OPTIMIZATION 2: Persistence
        localStorage.setItem('token', res.data.token);
        
        // 🚀 OPTIMIZATION 3: Full Handshake
        // Sending BOTH user and token so App.jsx can pass them to the Trade component
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
    <div className="flex items-center justify-center min-h-screen bg-[#0b0e11]">
      <div className="w-full max-w-md p-8 bg-[#161a1e] border border-gray-800 rounded-2xl shadow-2xl">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-yellow-500 mb-2 font-mono tracking-tighter">NEXUSTRADE</h1>
          <p className="text-gray-400 text-sm font-mono uppercase">
            {isLogin ? '> Welcome back, Terminal User' : '> Initialize new trading identity'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {!isLogin && (
            <input
              type="text"
              placeholder="USERNAME"
              className="w-full bg-[#0b0e11] border border-gray-700 p-3 rounded font-mono text-sm focus:border-yellow-500 outline-none text-white transition-all"
              onChange={(e) => setFormData({ ...formData, username: e.target.value })}
              required
            />
          )}

          <input
            type="email"
            placeholder="EMAIL ADDRESS"
            className="w-full bg-[#0b0e11] border border-gray-700 p-3 rounded font-mono text-sm focus:border-yellow-500 outline-none text-white transition-all"
            onChange={(e) => setFormData({ ...formData, email: e.target.value })}
            required
          />

          <input
            type="password"
            placeholder="PASSWORD"
            className="w-full bg-[#0b0e11] border border-gray-700 p-3 rounded font-mono text-sm focus:border-yellow-500 outline-none text-white transition-all"
            onChange={(e) => setFormData({ ...formData, password: e.target.value })}
            required
          />

          <button 
            disabled={loading}
            className="w-full bg-yellow-500 hover:bg-yellow-400 text-black font-bold py-3 rounded-lg transition-all mt-4 uppercase tracking-widest text-sm disabled:opacity-50"
          >
            {loading ? 'Processing...' : isLogin ? 'Authorize Access' : 'Create Identity'}
          </button>
        </form>

        <div className="mt-8 pt-6 border-t border-gray-800 text-center">
          <p className="text-gray-500 text-xs font-mono">
            {isLogin ? "NEW TO THE PLATFORM?" : "CREDENTIALS ALREADY EXIST?"}
            <button
              className="text-yellow-500 ml-2 hover:underline font-bold"
              onClick={() => setIsLogin(!isLogin)}
            >
              {isLogin ? '[REGISTER]' : '[LOGIN]'}
            </button>
          </p>
        </div>
      </div>
    </div>
  );
};

export default Auth;