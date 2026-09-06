import html from './index.html';
import {handleRequest} from './worker.js';
export default {fetch: (request,env)=>handleRequest(request,env,html)};
