import { useState } from 'react'
import { authClient } from '../auth'

export function Login() {
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in')
  const [error, setError] = useState<string>()

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const email = String(form.get('email'))
    const password = String(form.get('password'))
    const result =
      mode === 'sign-up'
        ? await authClient.signUp.email({
            email,
            password,
            name: String(form.get('name') || email),
          })
        : await authClient.signIn.email({ email, password })
    setError(result.error?.message)
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>{mode === 'sign-in' ? 'Sign in' : 'Create an account'}</h2>
      {mode === 'sign-up' && <input name="name" placeholder="Name" />}
      <input name="email" type="email" placeholder="Email" required />
      <input
        name="password"
        type="password"
        placeholder="Password (8+ chars)"
        minLength={8}
        required
      />
      {error && <p className="error">{error}</p>}
      <button type="submit">{mode === 'sign-in' ? 'Sign in' : 'Sign up'}</button>
      <button
        type="button"
        className="link"
        onClick={() => setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in')}
      >
        {mode === 'sign-in' ? 'No account? Sign up' : 'Already registered? Sign in'}
      </button>
    </form>
  )
}
