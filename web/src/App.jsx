import { Route, Routes } from 'react-router-dom'
import Layout from './components/Layout.jsx'
import Schedule from './pages/Schedule.jsx'
import Availability from './pages/Availability.jsx'
import Admin from './pages/Admin.jsx'

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Schedule />} />
        <Route path="availability" element={<Availability />} />
        <Route path="admin" element={<Admin />} />
        <Route path="*" element={<Schedule />} />
      </Route>
    </Routes>
  )
}
