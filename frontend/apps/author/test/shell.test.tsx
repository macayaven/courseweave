import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthorShell } from '../src/app';

afterEach(cleanup);
describe('Author shell', () => {
  it('keeps all non-chat regions usable when no provider is configured', () => {
    render(<AuthorShell state="Ready. Curriculum teacher provider unavailable." provider="not_configured" />);
    for (const region of ['Outline', 'Inspector', 'Preview', 'Curriculum teacher']) expect(screen.getByRole('region', { name: region })).toBeInTheDocument();
    expect(screen.getAllByText(/provider unavailable/i)).not.toHaveLength(0);
  });
});
