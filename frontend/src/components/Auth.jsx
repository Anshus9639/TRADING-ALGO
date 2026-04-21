import React, { useState } from 'react';
import axios from 'axios';

const Auth = ({ onLogin }) => {
  // Toggle between Login and Signup view
  const [isLogin, setIsLogin] = useState(true);
  const [formData, setFormData] = useState({
    username: '',
    email: '',
    password: ''
  });

  const handleSubmit = async (e) => {
    e.preventDefault();

    // Determine which backend route to hit
    const endpoint = isLogin ? '/api/auth/login' : '/api/auth/signup';

    try {
      const res = await axios.post(`https://trading-algo-nqud.onrender.com${endpoint}`, formData);

      if (isLogin) {
        // 1. Save the JWT token to the browser's storage
        localStorage.setItem('token', res.data.token);

        // 2. Pass the user data back to App.jsx
        onLogin(res.data.user);
      } else {
        // If Signup was successful, switch to Login view
        alert(res.data.msg || "Account created! Please log in.");
        setIsLogin(true);
      }
    } catch (err) {
      // Show the specific error from the backend (e.g., "User already exists")
      alert(err.response?.data?.msg || "Authentication failed");
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen bg-[#0b0e11]">
      <div className="w-full max-w-md p-8 bg-[#161a1e] border border-gray-800 rounded-2xl shadow-2xl">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-yellow-500 mb-2 font-mono tracking-tighter">NEXUSTRADE</h1>
          <p className="text-gray-400 text-sm">
            {isLogin ? 'Welcome back, Terminal User' : 'Initialize new trading account'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Only show Username field during Signup */}
          {!isLogin && (
            <input
              type="text"
              placeholder="Username"
              className="w-full bg-[#0b0e11] border border-gray-700 p-3 rounded focus:border-yellow-500 outline-none text-white transition-all"
              onChange={(e) => setFormData({ ...formData, username: e.target.value })}
              required
            />
          )}

          <input
            type="email"
            placeholder="Email Address"
            className="w-full bg-[#0b0e11] border border-gray-700 p-3 rounded focus:border-yellow-500 outline-none text-white transition-all"
            onChange={(e) => setFormData({ ...formData, email: e.target.value })}
            required
          />

          <input
            type="password"
            placeholder="Password"
            className="w-full bg-[#0b0e11] border border-gray-700 p-3 rounded focus:border-yellow-500 outline-none text-white transition-all"
            onChange={(e) => setFormData({ ...formData, password: e.target.value })}
            required
          />

          <button className="w-full bg-yellow-500 hover:bg-yellow-400 text-black font-bold py-3 rounded-lg transition-all mt-4 uppercase tracking-widest text-sm">
            {isLogin ? 'Authorize Access' : 'Create Identity'}
          </button>
        </form>

        <div className="mt-8 pt-6 border-t border-gray-800 text-center">
          <p className="text-gray-500 text-sm">
            {isLogin ? "New to the platform?" : "Already have credentials?"}
            <button
              className="text-yellow-500 ml-2 hover:underline font-bold"
              onClick={() => setIsLogin(!isLogin)}
            >
              {isLogin ? 'Register' : 'Login'}
            </button>
          </p>
        </div>
      </div>
    </div>
  );
};

// CRITICAL: This default export fixes the error you saw earlier!
export default Auth;