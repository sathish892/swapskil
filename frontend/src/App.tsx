import { Routes, Route, Navigate } from 'react-router-dom';
import MainLayout from '../layouts/MainLayout';
import Home from '../pages/Home';
import AdminLogin from '../pages/AdminLogin';
import { AdminLayout, AdminPage } from '../pages/AdminArea';
import RequireAuth from '../components/RequireAuth';
import { UserLogin, UserRegister } from '../pages/UserAuth';
import MySkillsPage from '../pages/MySkillsPage';
import MatchesPage from '../pages/MatchesPage';
import ProfilePreview from '../pages/ProfilePreview';
import SwapRequestsPage from '../pages/SwapRequestsPage';
import SwapRequestDetailsPage from '../pages/SwapRequestDetailsPage';
import { OwnProfilePage, ProfileEditPage, PublicProfilePage } from '../pages/ProfilePages';
import MessagesPage from '../pages/MessagesPage';
import NotificationsPage from '../pages/NotificationsPage';
import DashboardPage from '../pages/DashboardPage';
import FindSkillsPage from '../pages/FindSkillsPage';
import SkillDetailsPage from '../pages/SkillDetailsPage';
import AvailabilityPage from '../pages/AvailabilityPage';
import SessionsPage from '../pages/SessionsPage';
import PaymentsPage from '../pages/PaymentsPage';
import SubscriptionPage from '../pages/SubscriptionPage';
import AboutPage from '../pages/AboutPage';
import { AccountSettingsPage, BlockedUsersPage, PrivacySettingsPage, SafetyCenterPage, SecuritySettingsPage } from '../pages/SafetySettingsPages';
import RequireSubscription from '../components/RequireSubscription';

export default function App() {
  return (
    <Routes>
      <Route element={<MainLayout />}>
        <Route path="/" element={<Home />} />
        <Route path="/about" element={<AboutPage />} />
        <Route path="/login" element={<UserLogin />} />
        <Route path="/register" element={<UserRegister />} />
        <Route path="/profile/:userId" element={<PublicProfilePage />} />
        <Route element={<RequireAuth />}>
          <Route path="/subscription" element={<SubscriptionPage />} />
          <Route element={<RequireSubscription />}>
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/my-skills" element={<MySkillsPage />} />
          <Route path="/skills/:skillId" element={<SkillDetailsPage />} />
          <Route path="/matches" element={<MatchesPage />} />
          <Route path="/find-skills" element={<FindSkillsPage />} />
          <Route path="/profile" element={<OwnProfilePage />} />
          <Route path="/profile/edit" element={<ProfileEditPage />} />
          <Route path="/messages" element={<MessagesPage />} />
          <Route path="/messages/:conversationId" element={<MessagesPage />} />
          <Route path="/notifications" element={<NotificationsPage />} />
          <Route path="/availability" element={<AvailabilityPage />} />
          <Route path="/sessions" element={<SessionsPage />} />
          <Route path="/sessions/:sessionId" element={<SessionsPage />} />
          <Route path="/payments" element={<PaymentsPage />} />
          <Route path="/settings/privacy" element={<PrivacySettingsPage />} />
          <Route path="/settings/security" element={<SecuritySettingsPage />} />
          <Route path="/settings/blocked-users" element={<BlockedUsersPage />} />
          <Route path="/settings/account" element={<AccountSettingsPage />} />
          <Route path="/safety" element={<SafetyCenterPage />} />
          <Route path="/profiles/:userId" element={<ProfilePreview />} />
          <Route path="/swap-requests" element={<SwapRequestsPage />} />
          <Route path="/swap-requests/:swapRequestId" element={<SwapRequestDetailsPage />} />
          </Route>
        </Route>
      </Route>
      <Route path="/admin/login" element={<AdminLogin />} />
      <Route path="/admin" element={<AdminLayout />}>
        <Route index element={<Navigate to="dashboard" replace />} />
        <Route path="dashboard" element={<AdminPage />} />
        <Route path="users" element={<AdminPage />} />
        <Route path="users/:userId" element={<AdminPage />} />
        <Route path="skills" element={<AdminPage />} />
        <Route path="reports" element={<AdminPage />} />
        <Route path="reports/:reportId" element={<AdminPage />} />
        <Route path="swaps" element={<AdminPage />} />
        <Route path="swaps/:swapRequestId" element={<AdminPage />} />
        <Route path="payments" element={<AdminPage />} />
        <Route path="subscriptions" element={<AdminPage />} />
        <Route path="audit-logs" element={<AdminPage />} />
        <Route path="settings" element={<AdminPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
