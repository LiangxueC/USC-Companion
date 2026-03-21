import React, { useState } from 'react';
import { HomeScreen } from './HomeScreen';
import AssignmentTracker from './AssignmentTracker';

type Screen = 'home' | 'assignments';

export default function App() {
  const [screen, setScreen] = useState<Screen>('home');

  if (screen === 'assignments') {
    return <AssignmentTracker onBack={() => setScreen('home')} />;
  }

  return <HomeScreen onOpenAssignments={() => setScreen('assignments')} />;
}