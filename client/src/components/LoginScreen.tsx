import { useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { Lock, Eye, EyeOff } from 'lucide-react';
import logoUrl from "@/assets/foot_1765425850372.png";

export function LoginScreen() {
  const { isInitialized, setupPassword, login, isLoading } = useAuth();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const { toast } = useToast();

  const handleSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (password.length < 8) {
      setError('Password must be at least 8 characters long');
      return;
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    try {
      await setupPassword(password);
      toast({
        title: 'Vault Created',
        description:
          'Your vault is ready. The password locks access to the app but does not encrypt vault data on disk. Use an encrypted disk or container for at-rest protection.',
      });
    } catch (err) {
      setError('Failed to create vault. Please try again.');
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    try {
      const success = await login(password);
      if (!success) {
        setError('Incorrect password');
      }
    } catch (err) {
      setError('Login failed. Please try again.');
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-4">
            <img src={logoUrl} alt="KYUTXO Logo" className="h-16 w-auto" />
          </div>
          <CardTitle className="text-2xl">KYUTXO Vault</CardTitle>
          <CardDescription>
            {isInitialized
              ? 'Enter your password to unlock the app and access your vault.'
              : 'Create a password to lock access to the app.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={isInitialized ? handleLogin : handleSetup} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <div className="relative flex items-center">
                <Lock className="absolute left-3 h-4 w-4 text-muted-foreground pointer-events-none" />
                <Input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  className="pl-10 pr-10"
                  disabled={isLoading}
                  data-testid="input-password"
                />
                <button
                  type="button"
                  className="absolute right-3 text-muted-foreground hover:text-foreground"
                  onClick={() => setShowPassword(!showPassword)}
                  data-testid="button-toggle-password"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {!isInitialized && (
              <div className="space-y-2">
                <Label htmlFor="confirmPassword">Confirm Password</Label>
                <div className="relative flex items-center">
                  <Lock className="absolute left-3 h-4 w-4 text-muted-foreground pointer-events-none" />
                  <Input
                    id="confirmPassword"
                    type={showPassword ? 'text' : 'password'}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Confirm your password"
                    className="pl-10"
                    disabled={isLoading}
                    data-testid="input-confirm-password"
                  />
                </div>
              </div>
            )}

            {error && (
              <p className="text-sm text-destructive" data-testid="text-error">
                {error}
              </p>
            )}

            <Button
              type="submit"
              className="w-full"
              disabled={isLoading}
              data-testid="button-submit"
            >
              {isLoading ? 'Please wait...' : isInitialized ? 'Unlock Vault' : 'Create Vault'}
            </Button>

            <div className="text-xs text-muted-foreground text-center space-y-1">
                <p>
                  Your password locks access to the app; it does not encrypt
                  vault data stored on disk.
                </p>
                <p>
                  For at-rest protection, keep the vault on an encrypted disk
                  or container.
                </p>
              {!isInitialized && (
                <p className="font-medium text-destructive">
                  Remember your password to access the app.
                </p>
              )}
              </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
