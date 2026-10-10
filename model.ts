import {createDeepAgent} from 'deepagents'
import {AIMessage, HumanMessage, SystemMessage, ToolMessage, initChatModel,tool} from 'langchain'
import {MultiServerMCPClient} from '@langchain/mcp-adapters'
import {ChatOpenRouter} from '@langchain/openrouter'
import dotenv from 'dotenv'
import OpenAi from 'openai'
import z from 'zod'
import { BaseMessage, MessageStructure, MessageToolSet } from '@langchain/core/messages'

dotenv.config()

interface Messages {
    role:'system' | 'user'| 'ai', content:string
}

const getWeather = tool(({city})=>{
    return `ther current weather of ${city} is 30 deg celcius`
},{name:'get-weather',description:'it can tell what is the current weather of a city',schema:z.object({city:z.string()})})


const getAge = tool(({name})=>{
    return `${name} age is ${23}`
},{name:'get-age',description:'get age by person name', schema:z.object({name:z.string()})})

const model = new ChatOpenRouter('gpt-4o-mini',{apiKey:process.env.OPENROUTER_API_KEY,temperature:.7})

let messages:BaseMessage[]= [new SystemMessage('you are a funny guy reply every message in a funny way')]

async function Chat(humanMsg?:string,toolMsg?: BaseMessage){
    
    if(humanMsg){
        messages.push(new HumanMessage(humanMsg))
    }

    if(toolMsg) messages.push(toolMsg)

const agent = createDeepAgent({model,tools:[getWeather,getAge]})
const res = await agent.invoke({messages})


console.log(res.messages.at(-1)?.response_metadata)
console.log(res.messages.at(-1)?.content)

}

Chat('hi my name is habib and i live in dhaka. can you tell me what is my age and about weather')