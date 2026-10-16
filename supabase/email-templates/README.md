# Arabic email templates (Supabase Auth)

Pasted by hand in the Supabase dashboard: Authentication -> Emails (Templates). The management token used in the sandbox cannot write auth settings.

| Template | Subject | File |
|---|---|---|
| Confirm signup | تفعيل حسابك في دعوات | confirm-signup.html |
| Reset password | تغيير كلمة المرور في دعوات | reset-password.html |

- Both use `{{ .ConfirmationURL }}` (the default hash-token link style our `Data.auth.recoveryFromUrl` reads).
- Email-safe HTML: tables and inline CSS only, no images or remote fonts, RTL.
- Custom SMTP (a cutover item) is still needed before real customers receive them.
