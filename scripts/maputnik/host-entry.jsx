import {IconContext} from "react-icons";
import {createRoot} from "react-dom/client";
import "./styles/index.scss";
import "./host-layout.css";
import "./i18n";
import App from "./components/App";
createRoot(document.getElementById("app")).render(<IconContext.Provider value={{className:"react-icons"}}><App/></IconContext.Provider>);
